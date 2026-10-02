import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// NOTE: relative imports, not @/ — lib/prisma.ts precedent. Plain node runs
// the check scripts and cannot resolve the @/ alias, so everything this
// module pulls in must resolve relatively (it does: prisma, version,
// db-provider and envfile have no @/ imports of their own).
import prisma from "./prisma";
import { APP_VERSION, REPO } from "./version";
import { getHostIdentity } from "./hostidentity";
import { providerFromEnv } from "./db-provider";
import { ENV_FILE } from "./envfile";

const run = promisify(execFile);

export const APP_DIR = process.cwd();
// "scottchristian/subwave-listener" -> "subwave-listener" for filenames.
const REPO_NAME = (REPO.split("/")[1] || "subwave-listener").toLowerCase();
export const BACKUP_DIR = path.join(APP_DIR, "data", "backups");
export const BRAND_DIR = path.join(APP_DIR, "data", "brand");
export const MARKER_FILE = path.join(path.dirname(ENV_FILE), ".setup-complete");

// Server-side snapshots are rollback material for the in-app updater, not
// archives. Ten is enough history to be useful without growing the disk
// silently; anything older is pruned on the next create.
export const BACKUP_RETENTION = 10;

/**
 * Make a name safe for a filename: lowercase, runs of anything else become one
 * hyphen, leading/trailing hyphens trimmed. "Causeway FM" -> "causeway-fm".
 * Falls back rather than returning empty, because an empty slug makes a broken
 * filename and a weird station name should not break downloads.
 */
export function slugifyName(raw: string, fallback: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

// Every table, in an order that respects the only foreign keys in the schema:
// everything with a userId points at User, so User is written first and wiped
// last. Tables without relations can go anywhere; they sit with the dependents
// so a partial failure still leaves principals intact the longest.
const TABLES_IN_WRITE_ORDER = [
  "user",
  "account",
  "session",
  "verificationToken",
  "streamSession",
  "donation",
  "setting",
  "songRequest",
  "songLike",
  "songLinkCache",
  "pushSubscription",
  "presenceHeartbeat",
  "skillRun",
] as const;

export type BackupManifest = {
  id: string;
  label: string;
  createdAt: string;
  appVersion: string;
  /** Station name as known when the backup was taken (host, else baked env). */
  stationName: string;
  dbProvider: string;
  /** Row counts per table, as dumped. Missing tables are absent, not zero. */
  tables: Record<string, number>;
  /** Env key names only — values live in env.json beside this file. */
  envKeys: string[];
  brandFiles: number;
  markerPresent: boolean;
};

export type BackupSummary = BackupManifest & { sizeBytes: number };

function backupPath(id: string): string {
  // Ids are generated here (timestamp + random), never from user input — but a
  // restore route takes one from the URL, so keep the traversal guard in one
  // place rather than trusting every caller. Underscores allowed: the generator
  // uses one between the date and the time.
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error("bad backup id");
  return path.join(BACKUP_DIR, id);
}

/** Parse a KEY="value" env file. Handles the \\ and \" escapes updateEnvFile writes. */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = v;
  }
  return out;
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSizeBytes(p);
      else if (e.isFile()) total += (await fs.stat(p)).size;
    }
  } catch {
    // missing dir counts as zero
  }
  return total;
}

async function countBrandFiles(): Promise<number> {
  let n = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (e.isFile()) n++;
    }
  };
  await walk(BRAND_DIR);
  return n;
}

/**
 * Snapshot everything that makes this station this station: the env file, the
 * whole database, the operator artwork, and the setup marker.
 *
 * Synchronous and complete before it returns — the in-app updater calls this
 * immediately before replacing source, and a half-written backup is worse than
 * none, so there is no backgrounding. Typical stations take seconds (a few
 * thousand listening-history rows dominate).
 */
export async function createBackup(label = ""): Promise<BackupSummary> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  const id = `${stamp}-${rand}`;
  // Station name for the download filename. Host first (it owns the name),
  // baked env as fallback, never fatal.
  let stationName = process.env.NEXT_PUBLIC_STATION_NAME || "";
  try {
    stationName = (await getHostIdentity()).name || stationName;
  } catch {
    // unreachable host — env fallback (possibly empty) stands
  }
  const dir = backupPath(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    // 1. Env, stored twice: raw bytes (what restore writes back — comments,
    // `export` lines and all) and parsed JSON (what lets a future UI show what's
    // inside without re-parsing). Restoring from raw means a line the parser
    // skips can never be silently dropped.
    const envRaw = await fs.readFile(ENV_FILE, "utf8").catch((e) => {
      throw new Error(`cannot read env file: ${(e as Error).message}`);
    });
    const env = parseEnvFile(envRaw);
    await fs.writeFile(path.join(dir, "env.raw"), envRaw, { mode: 0o600 });
    await fs.writeFile(path.join(dir, "env.json"), JSON.stringify(env, null, 2), { mode: 0o600 });

    // 2. Database, table by table. A table that does not exist (older schema,
    // partial migrate) is skipped, not fatal — the manifest records what was
    // actually dumped, and restore only touches those tables.
    const db: Record<string, unknown[]> = {};
    const tables: Record<string, number> = {};
    for (const t of TABLES_IN_WRITE_ORDER) {
      try {
        const rows = await (prisma as any)[t].findMany();
        db[t] = rows;
        tables[t] = rows.length;
      } catch {
        // no such table — leave it out of both
      }
    }
    await fs.writeFile(path.join(dir, "db.json"), JSON.stringify(db), { mode: 0o600 });

    // 3. Operator artwork. cp -r rather than a file list: new asset kinds added
    // later are included without anyone remembering to list them.
    const brandDest = path.join(dir, "brand");
    try {
      await fs.cp(BRAND_DIR, brandDest, { recursive: true });
    } catch {
      await fs.mkdir(brandDest, { recursive: true });
    }
    const brandFiles = await countBrandFiles();

    // 4. Setup marker, if present. Its presence IS the configured flag.
    let markerPresent = false;
    try {
      await fs.copyFile(MARKER_FILE, path.join(dir, ".setup-complete"));
      markerPresent = true;
    } catch {
      // fresh install with no marker — nothing to keep
    }

    const manifest: BackupManifest = {
      id,
      label,
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      stationName,
      dbProvider: providerFromEnv(),
      tables,
      envKeys: Object.keys(env),
      brandFiles,
      markerPresent,
    };
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    await pruneBackups();

    return { ...manifest, sizeBytes: await dirSizeBytes(dir) };
  } catch (e) {
    // A failed backup must not leave a directory that looks complete.
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export async function listBackups(): Promise<BackupSummary[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const out: BackupSummary[] = [];
  for (const id of entries) {
    try {
      const raw = await fs.readFile(path.join(BACKUP_DIR, id, "manifest.json"), "utf8");
      const manifest = JSON.parse(raw) as BackupManifest;
      if (manifest.id !== id) continue;
      out.push({ ...manifest, sizeBytes: await dirSizeBytes(path.join(BACKUP_DIR, id)) });
    } catch {
      // incomplete or foreign directory — not a backup
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

async function pruneBackups(): Promise<void> {
  const all = await listBackups();
  for (const b of all.slice(BACKUP_RETENTION)) {
    await fs.rm(backupPath(b.id), { recursive: true, force: true }).catch(() => {});
  }
}

export async function deleteBackup(id: string): Promise<void> {
  await fs.rm(backupPath(id), { recursive: true, force: true });
}

/**
 * Pack a backup as a .tar.gz for download. Built in the backup dir so the
 * archive contains relative paths, then moved beside it — never inside it,
 * or the next list would trip over a giant file with no manifest.
 */
export async function archiveBackup(id: string): Promise<{ filePath: string; fileName: string }> {
  const dir = backupPath(id);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.id !== id) throw new Error("backup manifest mismatch");
  const fileName = `${slugifyName(REPO_NAME, "subwave-listener")}-${slugifyName(
    manifest.stationName || "",
    "station"
  )}-${id}.tar.gz`;
  const filePath = path.join(BACKUP_DIR, fileName);
  await fs.rm(filePath, { force: true });
  await run("tar", ["-czf", filePath, "-C", BACKUP_DIR, id]);
  await fs.chmod(filePath, 0o600);
  return { filePath, fileName };
}

export async function removeArchive(filePath: string): Promise<void> {
  if (!filePath.startsWith(BACKUP_DIR + path.sep)) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}

/**
 * Restore a backup: env, database, artwork, marker. Then the caller restarts —
 * the running process has already read the old env into memory, so restoring
 * without a bounce would leave the station running on values that no longer
 * exist on disk, which is exactly the disagreement a restore is meant to end.
 *
 * Database restore wipes each dumped table and re-inserts, inside one
 * transaction, principals before dependents. Tables absent from the dump are
 * left alone, so a backup from an older schema cannot delete data it never knew.
 * Requires confirm:true — there is no undo for a restore except another backup,
 * and one is taken automatically only by the updater, not here.
 */
export async function restoreBackup(id: string, confirm: boolean): Promise<{ tables: Record<string, number> }> {
  if (!confirm) throw new Error("restore needs explicit confirmation");
  const dir = backupPath(id);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  if (manifest.id !== id) throw new Error("backup manifest mismatch");

  // 1. Env first, so a later failure still leaves the file closest to the backup.
  // Written from the raw bytes, not re-rendered from parsed JSON: comments and
  // lines the parser skips (`export FOO=bar`) survive byte-faithfully. A merge
  // would be wrong here — keys added since the backup must not survive a rollback
  // to before they existed. Restore is for same-version rollback, where writing
  // exactly what was backed up is correct.
  const envRaw = await fs.readFile(path.join(dir, "env.raw"), "utf8");
  const tmp = `${ENV_FILE}.restore-${Date.now()}`;
  await fs.writeFile(tmp, envRaw, { mode: 0o600 });
  await fs.rename(tmp, ENV_FILE);

  // 2. Database. Dependents are wiped before User, re-inserted after — the
  // reverse of the dump order would violate the userId foreign keys halfway.
  const db = JSON.parse(await fs.readFile(path.join(dir, "db.json"), "utf8")) as Record<string, any[]>;
  const counts: Record<string, number> = {};
  const present = TABLES_IN_WRITE_ORDER.filter((t) => Array.isArray(db[t]));
  await prisma.$transaction(async (tx: any) => {
    for (const t of [...present].reverse()) {
      if (t === "user") continue;
      await tx[t].deleteMany();
    }
    if (present.includes("user")) await tx.user.deleteMany();
    for (const t of present) {
      const rows = db[t];
      if (!rows.length) {
        counts[t] = 0;
        continue;
      }
      // createMany in chunks: one 7,000-row statement is fine for Postgres but
      // SQLite binds every value, and the variable cap is real.
      for (let i = 0; i < rows.length; i += 500) {
        await tx[t].createMany({ data: rows.slice(i, i + 500) });
      }
      counts[t] = rows.length;
    }
  });

  // 3. Artwork. Brand dir is replaced wholesale — a file deleted since the backup
  // stays deleted... no: replaced wholesale means the backup wins entirely, which
  // is what rollback means. Current files are removed first so a logo added
  // after the backup does not survive a restore to before it.
  await fs.rm(BRAND_DIR, { recursive: true, force: true });
  try {
    await fs.cp(path.join(dir, "brand"), BRAND_DIR, { recursive: true });
  } catch {
    await fs.mkdir(BRAND_DIR, { recursive: true });
  }

  // 4. Marker follows the backup: restoring a pre-setup backup reopens the wizard.
  const markerSrc = path.join(dir, ".setup-complete");
  try {
    await fs.copyFile(markerSrc, MARKER_FILE);
  } catch {
    await fs.rm(MARKER_FILE, { force: true }).catch(() => {});
  }

  return { tables: counts };
}
