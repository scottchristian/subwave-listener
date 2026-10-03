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
// The previous source, as ONE archive — never a tree. A tree inside data/
// broke updates to any release whose tsconfig lacks the data exclude: the
// build typechecks data/update-source-snapshot/**/*.ts against the NEW tree,
// where the modules the snapshot imports do not exist yet. An archive is
// invisible to tsc, to route discovery and to every future tsconfig, by
// construction rather than by convention.
export const UPDATE_SNAPSHOT_FILE = "update-source-snapshot.tar.gz";
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

export type UpdateChannel = "release" | "main" | "develop";

/**
 * Exactly these three — anything else is not a place we fetch code from. A
 * client-supplied channel that is not on this list cannot turn into a fetch of
 * an attacker-chosen ref, for the same reason targets must parse as versions.
 */
export function parseChannel(raw: unknown): UpdateChannel {
  if (raw === "release" || raw === "main" || raw === "develop") return raw;
  throw new Error("unknown update channel");
}

export function channelTarballUrl(channel: Exclude<UpdateChannel, "release">): string {
  return `https://github.com/${REPO}/archive/refs/heads/${channel}.tar.gz`;
}

export type UpdateSource = {
  channel: UpdateChannel;
  /** Tag (releases) or branch name. */
  ref: string;
  /** Commit sha for branches; null for tags (the version is the identity). */
  sha: string | null;
  version: string;
  updatedAt: string;
};

export function sourcePath(appDir: string = process.cwd()): string {
  return path.join(appDir, "data", "update-source.json");
}

export async function readSource(appDir: string = process.cwd()): Promise<UpdateSource | null> {
  try {
    const raw = await fs.readFile(sourcePath(appDir), "utf8");
    const s = JSON.parse(raw) as UpdateSource;
    if (!s || (s.channel !== "release" && s.channel !== "main" && s.channel !== "develop")) return null;
    return s;
  } catch {
    return null;
  }
}

export async function writeSource(appDir: string, source: Omit<UpdateSource, "updatedAt">): Promise<void> {
  await fs.mkdir(path.join(appDir, "data"), { recursive: true });
  const tmp = sourcePath(appDir) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ ...source, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tmp, sourcePath(appDir));
}

/**
 * Refuse to install the branch tip the station already runs. Tags do not need
 * this — version comparison covers them — but two polls of the same branch can
 * return the same sha, and rebuilding an identical tree wastes minutes and a
 * restart for nothing.
 */
export function isSameSource(record: UpdateSource | null, channel: UpdateChannel, sha: string | null): boolean {
  if (!record || record.channel !== channel) return false;
  if (channel === "release") return false;
  return !!sha && record.sha === sha;
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

/**
 * May an update start? A running job owns the updater — anything else may.
 * Pure so the route and the tests agree on the answer.
 */
export function canStartUpdate(job: UpdateJob | null): { ok: true } | { ok: false; error: string } {
  if (jobRunning(job)) return { ok: false, error: "An update is already running" };
  return { ok: true };
}

/**
 * The on-air gate, same rule as deploy.sh: refuse with listeners on air (or an
 * unreadable room — unknown counts as occupied) unless the operator confirms
 * knowing the count. Pure so the route and the tests agree on the answer.
 */
export function gateOnListeners(
  listeners: number | null,
  confirmed: boolean
): { ok: true } | { ok: false; listeners: number | null; error: string } {
  if ((listeners === null || listeners > 0) && !confirmed) {
    return {
      ok: false,
      listeners,
      error:
        listeners === null
          ? "Could not read the listener count — confirm to update blind, or wait until the room is verifiably empty."
          : `${listeners} listener(s) on air — confirm to interrupt them, or wait until the room is empty.`,
    };
  }
  return { ok: true };
}

/**
 * May a manual rollback start? Needs a finished job with a backup behind it —
 * rolling back with nothing to roll back to would wipe settings for nothing.
 */
export function canRollback(job: UpdateJob | null): { ok: true; backupId: string } | { ok: false; error: string } {
  if (jobRunning(job)) return { ok: false, error: "An update is currently running" };
  if (!job?.backupId) return { ok: false, error: "Nothing to roll back to — no update backup on record" };
  return { ok: true, backupId: job.backupId };
}

/** A job younger than this that still says "running" owns the updater. */
export const JOB_STALE_MS = 2 * 60 * 60 * 1000;

export function jobRunning(job: UpdateJob | null): boolean {
  if (!job || job.status !== "running") return false;
  return Date.now() - Date.parse(job.updatedAt) < JOB_STALE_MS;
}

/**
 * Archive the live tree for rollback. Same exclusion set as copySourceTree
 * (deployment facts are never snapshotted), but as one tar.gz rather than a
 * tree — see UPDATE_SNAPSHOT_FILE for why a tree breaks the build it is meant
 * to save. Returns the archive path.
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
 * Snapshot the live tree into a single archive for rollback. The exclusion set
 * mirrors copySourceTree (deployment facts are never snapshotted, build output
 * never restores), expressed as tar flags. GNU and BSD tar both accept these.
 */
export async function snapshotSource(appDir: string, archivePath: string): Promise<number> {
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await run(
    "tar",
    [
      "-czf", archivePath,
      "--exclude=node_modules", "--exclude=.git", "--exclude=.next",
      "--exclude=data", "--exclude=.env.local", "--exclude=*.db",
      "--exclude=.DS_Store", "--exclude=tsconfig.tsbuildinfo",
      "-C", appDir, ".",
    ],
    { timeout: 300000 }
  );
  const { stdout } = await run("tar", ["-tzf", archivePath], { timeout: 60000 });
  const entries = stdout.split("\n").filter(Boolean);
  // A listing proves it is a real archive with real content; a byte floor would
  // be arbitrary (text compresses to almost nothing) and would false-fail on
  // small trees.
  if (!entries.length) throw new Error("source snapshot is empty — refusing");
  return entries.length;
}

/**
 * Restore a source snapshot: extract over the live tree, then delete live
 * files the snapshot does not contain (a renamed route must not linger).
 * Protected paths survive untouched — env, data and node_modules are restored
 * by their own flows (backup, reinstall), never by this one.
 */
export async function restoreSource(appDir: string, archivePath: string): Promise<void> {
  // Validate first: a corrupt archive must fail before it replaces anything.
  const { stdout } = await run("tar", ["-tzf", archivePath], { timeout: 60000 });
  const entries = stdout.split("\n").filter(Boolean);
  if (!entries.length) throw new Error("source snapshot is empty — refusing");
  for (const e of entries) {
    // Skip the archive's own root entry ("." or "./") — it names no file.
    if (e === "." || e === "./") continue;
    const rel = e.replace(/^\.\//, "");
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error("source snapshot has unsafe paths — refusing");
    }
    const top = rel.split("/")[0];
    if (PROTECTED_PATHS.includes(top)) {
      throw new Error(`source snapshot contains protected path ${top} — refusing`);
    }
  }
  await run("tar", ["-xzf", archivePath, "-C", appDir], { timeout: 300000 });
  const archived = new Set(entries.map((e) => e.replace(/^\.\//, "").replace(/\/$/, "")));
  const collect = async (dir: string, base: string, out: Set<string>): Promise<void> => {
    let list;
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (PROTECTED_PATHS.includes(e.name)) continue;
      if (e.name === ".next" || e.name === ".DS_Store" || e.name === "tsconfig.tsbuildinfo") continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) await collect(path.join(dir, e.name), rel, out);
      else if (e.isFile()) out.add(rel);
    }
  };
  const live = new Set<string>();
  await collect(appDir, "", live);
  for (const rel of live) {
    if (!archived.has(rel) && ![...archived].some((a) => a.startsWith(rel + "/"))) {
      await fs.rm(path.join(appDir, rel), { recursive: true, force: true });
    }
  }
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
