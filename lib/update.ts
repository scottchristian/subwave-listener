import { promises as fs, statfsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isNewerVersion, REPO } from "./version";

const run = promisify(execFile);

// Everything here takes an explicit appDir (defaulting to the live checkout) so
// the check suite can run every file operation against fixture trees. The only
// functions that touch the network, npm or pm2 are planUpdateTarget (GitHub
// API), runCommand (child processes) and the route layer's restart — none of
// which run in tests.

export const UPDATE_JOB_FILE = "update-job.json";
export const UPDATE_SNAPSHOT_DIR = "update-source-snapshot";
export const UPDATE_STAGE_DIR = "update-stage";

// Files that are deployment facts, not source. Never overwritten by an update,
// never snapshotted for rollback (they are restored from the backup instead,
// or left alone).
export const PROTECTED_PATHS = [".env.local", "data", "node_modules", ".git"];

// Release tarballs are small (source only); anything far beyond that is not
// what we asked for.
export const MAX_TARBALL_BYTES = 100 * 1024 * 1024;

// Minimum free disk before starting. Source + snapshot + tarball + a possible
// dependency reinstall and a build — 200MB is the floor below which nothing
// should even try; under 1GB the operator gets a warning, not a refusal.
export const MIN_DISK_BYTES = 200 * 1024 * 1024;
export const WARN_DISK_BYTES = 1024 * 1024 * 1024;

export type UpdateJobStatus =
  | "running"
  | "done"
  | "failed"
  | "rolled-back";

export type UpdateJob = {
  status: UpdateJobStatus;
  from: string;
  to: string;
  backupId: string | null;
  startedAt: string;
  updatedAt: string;
  /** Newest last. Kept short — a station does not need a build log forever. */
  log: string[];
  error?: string;
};

/**
 * Is this string something we would ever fetch and execute a build from?
 * Tags only, semver-shaped, never a branch name or a URL — a client-supplied
 * target that is not exactly a version cannot turn into a fetch of
 * attacker-chosen code.
 */
export function parseUpdateTarget(raw: unknown): string {
  const t = String(raw || "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t)) {
    throw new Error("not a version number");
  }
  return t;
}

/** Refuse anything that is not strictly an upgrade to a stable release. */
export function assertUpgradeAllowed(target: string, current: string, prerelease: boolean): void {
  if (prerelease) throw new Error("pre-releases are never installed automatically");
  if (!isNewerVersion(target, current)) throw new Error(`v${target} is not newer than v${current}`);
}

export function releaseTarballUrl(tag: string): string {
  const v = tag.startsWith("v") ? tag : `v${tag}`;
  return `https://github.com/${REPO}/archive/refs/tags/${v}.tar.gz`;
}

export function jobPath(appDir: string = process.cwd()): string {
  return path.join(appDir, "data", UPDATE_JOB_FILE);
}

export async function readJob(appDir: string = process.cwd()): Promise<UpdateJob | null> {
  try {
    const raw = await fs.readFile(jobPath(appDir), "utf8");
    const job = JSON.parse(raw) as UpdateJob;
    if (!job || typeof job.status !== "string") return null;
    return job;
  } catch {
    return null;
  }
}

export async function writeJob(appDir: string, job: UpdateJob): Promise<void> {
  await fs.mkdir(path.join(appDir, "data"), { recursive: true });
  const tmp = jobPath(appDir) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ ...job, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tmp, jobPath(appDir));
}

/** A job younger than this that still says "running" owns the updater. */
export const JOB_STALE_MS = 2 * 60 * 60 * 1000;

export function jobRunning(job: UpdateJob | null): boolean {
  if (!job || job.status !== "running") return false;
  return Date.now() - Date.parse(job.updatedAt) < JOB_STALE_MS;
}

/**
 * Copy a source tree, minus deployment facts. Used both ways: snapshotting the
 * live tree before an update, and putting it back on rollback. node_modules is
 * deliberately excluded — dependencies are reinstalled deterministically from
 * the lockfile when it changes, and snapshotting hundreds of megabytes per
 * update would turn every upgrade into a disk event.
 */
export async function copySourceTree(from: string, to: string): Promise<number> {
  let files = 0;
  const walk = async (src: string, dest: string): Promise<void> => {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const e of entries) {
      if (PROTECTED_PATHS.includes(e.name)) continue;
      // Skip build output and OS noise: both are regenerated, neither restores.
      if (e.name === ".next" || e.name === ".DS_Store" || e.name === "tsconfig.tsbuildinfo") continue;
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      if (e.isDirectory()) {
        await fs.mkdir(d, { recursive: true });
        await walk(s, d);
      } else if (e.isFile()) {
        await fs.copyFile(s, d);
        files++;
      }
    }
  };
  await fs.mkdir(to, { recursive: true });
  await walk(from, to);
  return files;
}

/**
 * Delete live files that the new tree no longer contains — the equivalent of
 * rsync --delete. Without this a renamed route file lingers and serves phantom
 * pages. Protected paths are never touched even if absent upstream.
 */
export async function pruneStaleFiles(appDir: string, stagedDir: string): Promise<number> {
  let removed = 0;
  const collect = async (dir: string, base: string, out: Set<string>): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.join(base, e.name);
      if (PROTECTED_PATHS.includes(e.name)) continue;
      if (e.name === ".next" || e.name === ".DS_Store" || e.name === "tsconfig.tsbuildinfo") continue;
      if (e.isDirectory()) await collect(path.join(dir, e.name), rel, out);
      else if (e.isFile()) out.add(rel);
    }
  };
  const live = new Set<string>();
  const staged = new Set<string>();
  await collect(appDir, "", live);
  await collect(stagedDir, "", staged);
  for (const rel of live) {
    if (!staged.has(rel)) {
      await fs.rm(path.join(appDir, rel), { force: true });
      removed++;
    }
  }
  return removed;
}

/** True when the staged tree wants different dependencies than the live one. */
export async function lockfileChanged(appDir: string, stagedDir: string): Promise<boolean> {
  const read = async (d: string) => fs.readFile(path.join(d, "package-lock.json"), "utf8").catch(() => null);
  const [a, b] = await Promise.all([read(appDir), read(stagedDir)]);
  if (a === null || b === null) return true; // missing lockfile: install to be safe
  return a !== b;
}

/** Run a build step, capturing output for the job log. Throws with the tail. */
export async function runStep(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return (stdout + (stderr ? "\n" + stderr : "")).slice(-4000);
  } catch (e: any) {
    const out = String(e?.stdout || "") + String(e?.stderr || "") + String(e?.message || e);
    throw new Error(out.slice(-2000) || "command failed");
  }
}

/** Absolute npm, because pm2 processes often run with a minimal PATH. */
export async function findNpm(): Promise<string> {
  const candidates = [process.execPath.replace(/\/node$/, "/npm"), "/usr/local/bin/npm", "/usr/bin/npm"];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // next
    }
  }
  try {
    const { stdout } = await run("npm", ["--version"], { timeout: 10000 });
    if (stdout.trim()) return "npm";
  } catch {
    // not on PATH
  }
  throw new Error("npm not found — install node/npm for the service user to update in-app");
}

export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}
