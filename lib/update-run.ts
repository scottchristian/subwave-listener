import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseUpdateTarget,
  assertUpgradeAllowed,
  releaseTarballUrl,
  copySourceTree,
  pruneStaleFiles,
  lockfileChanged,
  runStep,
  findNpm,
  freeDiskBytes,
  readJob,
  writeJob,
  jobRunning,
  stagedTarballPath,
  UPDATE_STAGED_DIR,
  MIN_DISK_BYTES,
  WARN_DISK_BYTES,
  MAX_TARBALL_BYTES,
  UPDATE_SNAPSHOT_FILE,
  snapshotSource,
  restoreSource,
  UPDATE_STAGE_DIR,
  type UpdateJob,
} from "@/lib/update";
import { APP_VERSION, REPO } from "@/lib/version";
import { createBackup, restoreBackup, validateBackup } from "@/lib/backup";
import { getSubwaveConfig } from "@/lib/subwave";
import { scheduleBounce } from "@/lib/pm2app";

const run = promisify(execFile);

/**
 * In-app update orchestration. Detection lives in the update-check route; this
 * is the doing: snapshot, download, swap, install, migrate, build, restart —
 * with rollback to the snapshot when anything before the restart fails.
 *
 * Nothing here runs in the check suite (network, npm, minutes of build, pm2),
 * so the unit-testable pieces live in lib/update.ts and this file stays thin
 * glue plus the two flows. What IS verified by hand: a scratch station, once,
 * before this ships — see the commit message.
 */

export type ReleaseInfo = {
  tag: string;
  version: string;
  prerelease: boolean;
  notes: string | null;
  tarballUrl: string;
};

/** The release as GitHub reports it. Throws human-readable on any failure. */
export async function fetchRelease(target: string): Promise<ReleaseInfo> {
  const version = parseUpdateTarget(target);
  const tag = `v${version}`;
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${REPO} update` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("could not reach GitHub — check the server has internet access");
  }
  if (res.status === 404) throw new Error(`no release ${tag} on GitHub`);
  if (res.status === 403) throw new Error("GitHub rate limit hit — try again in an hour");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = (await res.json()) as { tag_name?: string; prerelease?: boolean; draft?: boolean; body?: string };
  if (!rel.tag_name || rel.draft) throw new Error(`release ${tag} is not published`);
  assertUpgradeAllowed(version, APP_VERSION, rel.prerelease === true);
  return {
    tag,
    version,
    prerelease: rel.prerelease === true,
    notes: rel.body ? rel.body.slice(0, 2000) : null,
    tarballUrl: releaseTarballUrl(tag),
  };
}

export type BranchHead = { branch: string; sha: string; tarballUrl: string };

/** The tip of a branch, with the same trust model as a release tag: the repo is
 * fixed, the ref must be exactly main or develop, and the tarball URL is
 * derived — never taken from the network response or the client. */
export async function fetchBranchHead(branch: "main" | "develop"): Promise<BranchHead> {
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/branches/${branch}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${REPO} update` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error("could not reach GitHub — check the server has internet access");
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for branch ${branch}`);
  const d = (await res.json()) as any;
  const sha = d?.commit?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`GitHub did not return a commit for branch ${branch}`);
  }
  const { channelTarballUrl } = await import("@/lib/update");
  return { branch, sha, tarballUrl: channelTarballUrl(branch) };
}

/** How many listeners are on air right now. Unknown counts as a refusal reason. */
export async function listenerCount(): Promise<number | null> {
  try {
    const cfg = await getSubwaveConfig();
    if (!cfg.apiUrl) return null;
    const res = await fetch(`${cfg.apiUrl}/now-playing`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const d = (await res.json()) as any;
    const n = d?.listeners?.current;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

/**
 * The prisma CLI, resolved the way npm would resolve it. .bin/prisma is a
 * symlink into ../prisma/build, and the CLI locates its engine wasm relative
 * to the unresolved invocation path — executing the symlink directly makes it
 * look in .bin/ and die with ENOENT. npm exec resolves the link first, so we
 * do too; PATH npx is the fallback.
 */
/**
 * Resolve an installed binary the way npm would: through symlinks, not to
 * them. .bin entries are links into ../pkg/build, and CLIs that locate engine
 * files relative to their own path break when executed via the link — they
 * look beside the link instead of beside the real file. Returns the original
 * path when it is already real or cannot be read (caller falls back).
 */
export async function resolveInstalledBin(shimPath: string): Promise<string> {
  try {
    await fs.access(shimPath);
    try {
      return await fs.realpath(shimPath);
    } catch {
      return shimPath;
    }
  } catch {
    throw new Error(`not installed: ${shimPath}`);
  }
}

async function resolvePrisma(appDir: string): Promise<string> {
  try {
    return await resolveInstalledBin(path.join(appDir, "node_modules", ".bin", "prisma"));
  } catch {
    return "npx";
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await run(cmd, ["--version"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export type Preflight = {
  diskBytes: number | null;
  diskOk: boolean;
  diskWarn: boolean;
  npm: string | null;
  tar: boolean;
  prisma: boolean;
};

/** Everything the pipeline needs, checked before anything is downloaded. */
export async function preflight(appDir: string): Promise<Preflight> {
  const [diskBytes, tar] = await Promise.all([
    freeDiskBytes(appDir),
    commandExists("tar"),
  ]);
  let npm: string | null = null;
  try {
    npm = await findNpm();
  } catch {
    npm = null;
  }
  let prisma = false;
  try {
    prisma = ((await resolvePrisma(appDir)) === "npx" ? await commandExists("npx") : true);
  } catch {
    prisma = false;
  }
  return {
    diskBytes,
    diskOk: diskBytes === null ? true : diskBytes >= MIN_DISK_BYTES,
    diskWarn: diskBytes !== null && diskBytes < WARN_DISK_BYTES,
    npm,
    tar,
    prisma,
  };
}

/**
 * Download once, install many times. Fetches the tarball for a ref unless a
 * verified copy is already staged, validates it, and prunes other staged files
 * for the same channel — a stale tarball must never be mistaken for the
 * current one. Returns the staged path. This is what makes "downloaded and
 * verified before anyone is notified" true: the notifier and the pipeline call
 * the same function, so a notification implies an installable file on disk.
 */
export async function ensureStagedTarball(
  appDir: string,
  channel: "release" | "main" | "develop",
  ref: string,
  url: string
): Promise<string> {
  const stagedDir = path.join(appDir, "data", UPDATE_STAGED_DIR);
  await fs.mkdir(stagedDir, { recursive: true });
  const dest = stagedTarballPath(appDir, channel, ref);
  try {
    await fs.access(dest);
    await validateTarball(dest);
  } catch {
    // absent or corrupt — fetch it fresh below
    await downloadTarball(url, dest);
    await validateTarball(dest);
  }
  // Prune other staged files for this channel on every path, so only the
  // current ref remains — including when the wanted file was already there.
  const entries = await fs.readdir(stagedDir).catch(() => [] as string[]);
  for (const e of entries) {
    if (e.startsWith(`${channel}-`) && path.join(stagedDir, e) !== dest) {
      await fs.rm(path.join(stagedDir, e), { force: true }).catch(() => {});
    }
  }
  return dest;
}

/** Stream the tarball to disk with a size cap. Throws past the cap. */
export async function downloadTarball(url: string, dest: string): Promise<number> {
  const res = await fetch(url, {
    headers: { "User-Agent": `${REPO} update` },
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
  let bytes = 0;
  const fh = await fs.open(dest, "w", 0o600);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TARBALL_BYTES) {
        throw new Error("release archive larger than expected — refusing");
      }
      await fh.write(value);
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return bytes;
}

/**
 * Validate tar entries before extracting: one top-level dir, no absolute
 * paths, no `..`. A release tarball should only ever contain its own folder;
 * anything else means the download is not what we asked for.
 */
export async function validateTarball(archive: string): Promise<string> {
  const { stdout } = await run("tar", ["-tzf", archive], { timeout: 60000 });
  const entries = stdout.split("\n").filter(Boolean);
  if (!entries.length) throw new Error("release archive is empty");
  const tops = new Set<string>();
  for (const e of entries) {
    if (e.startsWith("/") || e.split("/").includes("..")) {
      throw new Error("release archive has unsafe paths — refusing");
    }
    tops.add(e.split("/")[0]);
  }
  if (tops.size !== 1) throw new Error("release archive layout unexpected — refusing");
  return [...tops][0];
}

async function jobLog(appDir: string, job: UpdateJob, line: string): Promise<UpdateJob> {
  const next = { ...job, log: [...job.log.slice(-49), line] };
  await writeJob(appDir, next);
  return next;
}

async function failJob(appDir: string, job: UpdateJob, error: string): Promise<UpdateJob> {
  const next: UpdateJob = { ...job, status: "failed", error };
  await writeJob(appDir, next);
  return next;
}

/**
 * Put the previous source back after a failed update: files, settings,
 * database, artwork — then rebuild so .next matches the restored source.
 * The station was never restarted (restart is the last step), so this runs in
 * the still-live old process.
 */
export async function rollbackSource(appDir: string): Promise<void> {
  const snapFile = path.join(appDir, "data", UPDATE_SNAPSHOT_FILE);
  await fs.access(snapFile);
  await restoreSource(appDir, snapFile);
}

/**
 * The pipeline. Launched without awaiting (the route responds immediately and
 * the client polls the job file), and every step writes through it — including
 * across the pm2 restart at the end, which the file survives and the process
 * does not.
 */
export type UpdatePlan = {
  channel: "release" | "main" | "develop";
  /** Display version: the tag version, or branch@sha7 until the build bakes its own. */
  version: string;
  tag: string;
  tarballUrl: string;
  sha: string | null;
  notes: string | null;
};

export async function runUpdatePipeline(appDir: string, plan: UpdatePlan): Promise<void> {
  let job = (await readJob(appDir)) as UpdateJob;
  const log = async (line: string) => {
    job = await jobLog(appDir, job, line);
  };

  try {
    const label = plan.channel === "release" ? plan.tag : `${plan.channel}@${(plan.sha || "").slice(0, 7)}`;
    await log(`${label} confirmed on GitHub`);

    const pre = await preflight(appDir);
    if (!pre.tar) throw new Error("tar not found on this server");
    if (!pre.npm) throw new Error("npm not found for the service user");
    if (!pre.prisma) throw new Error("prisma CLI not found — dependencies may need installing first");
    if (!pre.diskOk) throw new Error("too little free disk to update safely");
    if (pre.diskWarn) await log("warning: free disk under 1GB");
    await log("preflight passed");

    // Order is the confidence chain, and it matters: download and verify the
    // release FIRST (a corrupt download aborts before anything is touched),
    // then snapshot source, then back up settings and prove the backup. Only
    // after all three does the live tree change. The staged tarball is reused
    // when the notifier already fetched it — same file, re-validated.
    const planRef = plan.channel === "release" ? plan.version : (plan.sha as string);
    const staged = await ensureStagedTarball(appDir, plan.channel, planRef, plan.tarballUrl);
    const stagedBytes = (await fs.stat(staged)).size;
    await log(`release downloaded and verified (${(stagedBytes / 1048576).toFixed(1)} MB)`);

    // Snapshot source BEFORE the backup, so a failure between the two still
    // leaves the previous tree recoverable. node_modules excluded (reinstalled
    // from the lockfile when it changes).
    const snapFile = path.join(appDir, "data", UPDATE_SNAPSHOT_FILE);
    await fs.rm(snapFile, { force: true });
    const snapFiles = await snapshotSource(appDir, snapFile);
    await log(`source snapshotted (${snapFiles} files)`);

    const backup = await createBackup(`pre-update-${plan.channel === "release" ? `v${plan.version}` : `${plan.channel}-${(plan.sha || "").slice(0, 7)}`}`);
    job.backupId = backup.id;
    await writeJob(appDir, job);
    await log(`settings backed up (${backup.id})`);

    // Prove the backup restores before depending on it. A snapshot that cannot
    // be read back is not a safety net — abort now, while the station is still
    // untouched, rather than after its source has been replaced.
    const validation = await validateBackup(backup.id);
    for (const w of validation.warnings) await log(`backup warning: ${w}`);
    if (!validation.ok) {
      throw new Error(`pre-update backup failed validation: ${validation.errors.join("; ")}`);
    }
    await log(
      `backup validated (${validation.rows} rows in ${validation.tables} tables, ` +
        `${validation.envKeys} settings, ${validation.brandFiles} artwork files)`
    );

    // Everything is proven: the release is on disk and verified, the previous
    // source is snapshotted, the settings are backed up and validated. For an
    // automatic update this is the point of no return, so tell the admins now —
    // they asked to check it over once it is done.
    if (job.trigger === "auto") {
      const label = plan.channel === "release" ? `v${plan.version}` : plan.version;
      try {
        const { pushToAdmins } = await import("@/lib/push");
        await pushToAdmins(
          `Updating to ${label} now`,
          "Settings are backed up and verified. Check the station over once it is done — Admin → System → Software.",
          "/admin"
        );
        await log("admins notified that the update is starting");
      } catch (e) {
        // A failed notification must not abort a proven update.
        await log(`could not notify admins: ${(e as Error)?.message || "unknown"}`);
      }
    }

    const stageDir = path.join(appDir, "data", UPDATE_STAGE_DIR);
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.mkdir(stageDir, { recursive: true });
    const archive = path.join(stageDir, "release.tar.gz");
    await fs.copyFile(staged, archive);
    await validateTarball(archive);
    await run("tar", ["-xzf", archive, "--strip-components=1", "-C", stageDir], { timeout: 120000 });
    await log("release staged and verified");

    await copySourceTree(stageDir, appDir);
    const pruned = await pruneStaleFiles(appDir, stageDir);
    await log(`source updated (${pruned} stale files removed)`);
    // Compare against the staged tree (not the snapshot): a difference means the
    // release wants different dependencies than what is installed. Read before
    // the stage dir is removed below.
    const needInstall = await lockfileChanged(appDir, stageDir);
    await fs.rm(stageDir, { recursive: true, force: true });

    const npm = (await preflight(appDir)).npm as string;
    if (needInstall) {
      await log("dependencies changed — reinstalling (minutes)");
      await runStep(npm, ["ci", "--no-audit", "--no-fund"], appDir, 15 * 60 * 1000);
      await log("dependencies installed");
    }

    const { providerFromEnv } = await import("@/lib/db-provider");
    const envProvider = providerFromEnv();
    const prismaCmd = await resolvePrisma(appDir);
    // prisma/schema.prisma declares postgresql, and Prisma validates the URL
    // against the schema's own provider — so a file: URL is rejected before it
    // does anything. The swap above restored the canonical schema, which is
    // correct for Postgres and wrong for SQLite; generate the sqlite variant to
    // a temp path (inside prisma/ so migrations resolve) and point the commands
    // at it. Same pattern as the setup wizard's database step.
    let schemaArgs: string[] = [];
    if (envProvider === "sqlite") {
      const tmpSchema = path.join(appDir, "prisma", ".gen-sqlite.prisma");
      await runStep(process.execPath, [path.join(appDir, "scripts", "gen-schema.mjs"), "sqlite", tmpSchema], appDir, 60 * 1000);
      schemaArgs = ["--schema", tmpSchema];
    }
    await log(`syncing ${envProvider} schema`);
    if (envProvider === "postgresql") {
      await runStep(prismaCmd, ["db", "push", "--skip-generate", "--accept-data-loss"], appDir, 5 * 60 * 1000);
    } else {
      try {
        await runStep(prismaCmd, ["migrate", "deploy", ...schemaArgs], appDir, 5 * 60 * 1000);
      } catch (e) {
        // P3005: the database has tables but no migration history — born from
        // `db push` rather than `migrate deploy` (older setups, hand-built
        // stations). Refusing here would strand those stations on every future
        // update, so sync from the datamodel instead, exactly like Postgres.
        // Anything else rethrows: a genuinely broken migration must not be
        // papered over by a push.
        if (!/P3005/.test((e as Error)?.message || "")) throw e;
        await log("no migration history — syncing from the datamodel instead");
        await runStep(prismaCmd, ["db", "push", "--skip-generate", ...schemaArgs, "--accept-data-loss"], appDir, 5 * 60 * 1000);
      }
    }
    await runStep(prismaCmd, ["generate", ...schemaArgs], appDir, 5 * 60 * 1000);

    await log("building (minutes)");
    const before = await fs.stat(path.join(appDir, ".next", "BUILD_ID")).catch(() => null);
    await runStep(npm, ["run", "build"], appDir, 20 * 60 * 1000);
    const after = await fs.stat(path.join(appDir, ".next", "BUILD_ID")).catch(() => null);
    if (after && before && after.mtimeMs <= before.mtimeMs) {
      throw new Error("build did not produce a fresh BUILD_ID — refusing to restart into it");
    }
    await log("build fresh");

    // The snapshot stays: it is the manual-rollback material if this version
    // turns out bad once booted. One generation only — the next update replaces
    // it — so the disk cost is one source tree, without node_modules.
    // Record what is now installed, so reinstalling the same branch tip refuses
    // instead of rebuilding an identical tree for nothing.
    const { writeSource } = await import("@/lib/update");
    await writeSource(appDir, {
      channel: plan.channel,
      ref: plan.channel === "release" ? plan.tag : plan.channel,
      sha: plan.sha,
      version: plan.version,
    });
    job.to = plan.version;
    job.status = "done";
    await writeJob(appDir, job);
    scheduleBounce(2000);
  } catch (e) {
    const message = (e as Error)?.message || "update failed";
    try {
      await log(`FAILED: ${message} — rolling back`);
      await rollbackSource(appDir);
      const { restoreBackup } = await import("@/lib/backup");
      if (job.backupId) await restoreBackup(job.backupId, true);
      const npm2 = await findNpm().catch(() => null);
      if (npm2) {
        // The failed build may have left .next half-written (Next clears it
        // first), and the running old process serves from that directory — so
        // rebuild before calling this station healthy again.
        await runStep(npm2, ["run", "build"], appDir, 20 * 60 * 1000).catch(() => {});
      }
      job.status = "rolled-back";
      job.error = message;
      await writeJob(appDir, job);
    } catch (rb) {
      await failJob(appDir, job, `${message} (rollback also failed: ${(rb as Error)?.message})`);
    }
  }
}

/**
 * Manual rollback after a bad update booted: previous source back in place,
 * settings back from the update backup, dependencies re-synced when the
 * lockfile differs, then rebuild and restart. Runs in the (bad but booted)
 * new process; the snapshot and backup on disk are all it needs.
 */
export async function runManualRollback(appDir: string, backupId: string): Promise<void> {
  const before = await fs.readFile(path.join(appDir, "package-lock.json"), "utf8").catch(() => null);
  await rollbackSource(appDir);
  const { restoreBackup } = await import("@/lib/backup");
  await restoreBackup(backupId, true);
  const after = await fs.readFile(path.join(appDir, "package-lock.json"), "utf8").catch(() => null);
  const npm = await findNpm();
  if (before !== after) {
    await runStep(npm, ["ci", "--no-audit", "--no-fund"], appDir, 15 * 60 * 1000);
  }
  await runStep(npm, ["run", "build"], appDir, 20 * 60 * 1000);
  scheduleBounce(2000);
}
