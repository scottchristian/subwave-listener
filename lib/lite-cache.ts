import prisma from "@/lib/prisma";
import { providerFromEnv } from "@/lib/db-provider";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Only ever loaded dynamically (see liteClient): stations that never enable
// the cache, and stations not on Postgres at all, must not need the
// generated files to exist.
import type { PrismaClient as LiteClient } from "../prisma/lite-client/index.js";

/**
 * Limited-communication mode: serve likes and song-link lookups from a small
 * SQLite file on this server, and write Postgres back every N minutes.
 *
 * Why these two tables: they are the only user-driven reads that repeat on a
 * timer (likes poll per visible tab, links per track change). Everything else
 * already costs nothing idle. Reads prefer SQLite, creations buffer there,
 * and a flush pushes it all to Postgres — which stays the permanent record.
 * Unliking deletes both sides immediately: a delete that waited for the flush
 * could resurrect from the Postgres copy.
 *
 * SERVER-ONLY. The generated SQLite client is lazy-loaded so sqlite-primary
 * stations (and builds without the generated files) never touch it.
 */

export const LITE_KEYS = {
  enabled: "liteCacheEnabled",
  flushMinutes: "liteFlushMinutes",
  sessionMinutes: "liteSessionMinutes",
} as const;

export const LITE_DEFAULT_MINUTES = 20;
const LITE_MIN_MINUTES = 5;
const LITE_MAX_MINUTES = 240;

/**
 * How long a cached session verdict is trusted before Postgres is asked again.
 *
 * Twenty minutes on purpose, and the reason is the free tier: the database
 * sleeps after roughly fifteen idle minutes, so a shorter interval would mean a
 * query before every sleep and the station would never rest. Every revocation
 * the app knows about (sign-out, unapprove, session delete) drops the row
 * immediately instead of waiting this out — the window only covers a revocation
 * performed behind the app's back.
 */
export const LITE_DEFAULT_SESSION_MINUTES = 20;
const LITE_SESSION_MIN_MINUTES = 5;
const LITE_SESSION_MAX_MINUTES = 240;

// Short memory cache for the track-likes list: it carries a user join that
// cannot come from the SQLite mirror without duplicating PII there, so the
// merged answer rests here instead. Invalidated on every tap.
const TRACK_CACHE_TTL_MS = 5 * 60 * 1000;
const trackCache = new Map<string, { at: number; body: unknown[] }>();

// In-memory user display slice for unflushed likers. Bounded, short-lived;
// a nickname change shows up within minutes, and flushed rows resolve
// through the normal join anyway.
const USER_TTL_MS = 5 * 60 * 1000;
const userCache = new Map<string, { at: number; user: LikeUser }>();
const USER_CACHE_MAX = 500;

export type LikeUser = {
  id: string;
  name: string | null;
  nickname: string | null;
  image: string | null;
  hideLikeName: boolean | null;
} | null;

// Operator config, read once and kept in memory: reading it from Postgres on
// every request would be the very chatter this exists to avoid. Refreshed at
// boot, by the admin save, and ahead of every flush.
let memCfg: LiteConfig | null = null;

export type LiteConfig = {
  enabled: boolean;
  minutes: number;
  sessionMinutes: number;
};

const clamp = (v: number, lo: number, hi: number, dflt: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

export async function refreshLiteConfig(): Promise<LiteConfig> {
  let enabled = false;
  let minutes = LITE_DEFAULT_MINUTES;
  let sessionMinutes = LITE_DEFAULT_SESSION_MINUTES;
  try {
    const rows = await prisma.setting.findMany({
      where: {
        key: { in: [LITE_KEYS.enabled, LITE_KEYS.flushMinutes, LITE_KEYS.sessionMinutes] },
      },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    enabled = get(LITE_KEYS.enabled) === "true";
    minutes = clamp(Math.floor(Number(get(LITE_KEYS.flushMinutes))), LITE_MIN_MINUTES, LITE_MAX_MINUTES, LITE_DEFAULT_MINUTES);
    sessionMinutes = clamp(
      Math.floor(Number(get(LITE_KEYS.sessionMinutes))),
      LITE_SESSION_MIN_MINUTES,
      LITE_SESSION_MAX_MINUTES,
      LITE_DEFAULT_SESSION_MINUTES
    );
  } catch {
    // Unreadable database: keep the last known answer (or off).
  }
  memCfg = { enabled, minutes, sessionMinutes };
  writeLiteConfigFile(memCfg);
  return memCfg;
}

export function setLiteConfigLocal(enabled: boolean, minutes: number, sessionMinutes = LITE_DEFAULT_SESSION_MINUTES): void {
  memCfg = { enabled, minutes, sessionMinutes };
}

function liteConfigPath(): string {
  const override = process.env.LITE_CONFIG_PATH;
  if (override) return override;
  return `${process.cwd()}/data/lite-config.json`;
}

/** Persist alongside the in-memory copy: runtimes do not share memory, but
 * they share this disk — so the flush loop (instrumentation runtime) sees an
 * admin save (route runtime) within a minute, with zero Postgres reads. */
function writeLiteConfigFile(cfg: { enabled: boolean; minutes: number }): void {
  try {
    mkdirSync(dirname(liteConfigPath()), { recursive: true });
    writeFileSync(liteConfigPath(), JSON.stringify(cfg));
  } catch {}
}

function readLiteConfigFile(): LiteConfig | null {
  try {
    if (!existsSync(liteConfigPath())) return null;
    const d = JSON.parse(readFileSync(liteConfigPath(), "utf8")) as {
      enabled?: unknown; minutes?: unknown; sessionMinutes?: unknown;
    };
    if (typeof d.enabled !== "boolean") return null;
    return {
      enabled: d.enabled,
      minutes: clamp(Math.floor(Number(d.minutes)), LITE_MIN_MINUTES, LITE_MAX_MINUTES, LITE_DEFAULT_MINUTES),
      sessionMinutes: clamp(
        Math.floor(Number(d.sessionMinutes)),
        LITE_SESSION_MIN_MINUTES,
        LITE_SESSION_MAX_MINUTES,
        LITE_DEFAULT_SESSION_MINUTES
      ),
    };
  } catch {
    return null;
  }
}

/** True only on Postgres with the operator switch on. Test hook: LITE_CACHE_FORCE=1. */
export async function liteEnabled(): Promise<boolean> {
  if (process.env.LITE_CACHE_FORCE !== "1" && providerFromEnv() !== "postgresql") return false;
  if (!memCfg) await refreshLiteConfig();
  return memCfg?.enabled ?? false;
}

export function liteFlushMinutes(): number {
  return memCfg?.minutes ?? LITE_DEFAULT_MINUTES;
}

export function liteSessionMinutes(): number {
  return memCfg?.sessionMinutes ?? LITE_DEFAULT_SESSION_MINUTES;
}

function cacheDbUrl(): string {
  const override = process.env.LITE_CACHE_DB_PATH;
  if (override) return override.startsWith("file:") ? override : `file:${override}`;
  return `file:${process.cwd()}/data/lite-cache.db`;
}

let lite: LiteClient | null = null;

/**
 * When the next connection attempt is allowed.
 *
 * The cache is disposable by contract: Postgres is the real database, and if
 * this file disappears or is corrupted the station must carry on by reading
 * Postgres directly. So a failure never disables the cache permanently — that
 * was the previous behaviour, and it meant one unlucky error kept the cache
 * dark until the next restart. It now backs off and tries again, and an
 * unrecoverable file is deleted and rebuilt rather than abandoned.
 */
let retryAfter = 0;
/** Last repair attempt, so a permanently unavailable cache cannot thrash. */
let lastRepairAt = 0;
const RETRY_BACKOFF_MS = 30_000;

/** Forget everything (tests, and the admin switch-off path keeps it simple). */
export function resetLiteState(): void {
  void lite?.$disconnect?.().catch?.(() => {});
  lite = null;
  retryAfter = 0;
  lastRepairAt = 0;
  trackCache.clear();
  userCache.clear();
}

async function liteClient(): Promise<LiteClient | null> {
  if (lite) return lite;
  if (Date.now() < retryAfter) return null;
  try {
    const mod = await import("../prisma/lite-client/index.js");
    const c = new mod.PrismaClient({ datasources: { db: { url: cacheDbUrl() } } });
    await ensureCacheTables(c as unknown as LiteClient);
    lite = c as unknown as LiteClient;
    retryAfter = 0;
    return lite;
  } catch {
    // No generated files, no data dir, locked disk — the caller falls back to
    // direct Postgres. A broken cache must never break the feature.
    retryAfter = Date.now() + RETRY_BACKOFF_MS;
    return null;
  }
}

/**
 * Rebuild the cache file after it is deleted or corrupted.
 *
 * Called only from the failure path. A cache that cannot be opened is thrown
 * away and recreated: it holds nothing that is not already in Postgres, so
 * losing it costs one revalidation round and nothing else. Returns false if it
 * still cannot be opened, in which case the caller reads Postgres.
 */
async function rebuildCache(): Promise<LiteClient | null> {
  try {
    await lite?.$disconnect?.().catch?.(() => {});
    lite = null;
    // Clear the backoff before retrying. The failed open that led here set it,
    // and leaving it in place would make the repair attempt below give up
    // immediately — which is how a deleted file stayed unusable for the whole
    // backoff window instead of simply being rebuilt.
    retryAfter = 0;
    const { rmSync } = await import("node:fs");
    const url = cacheDbUrl().replace(/^file:/, "");
    // -wal and -shm too: a half-deleted set is what produces "database disk
    // image is malformed" on the next open.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${url}${suffix}`, { force: true });
    return await liteClient();
  } catch {
    return null;
  }
}

/**
 * Run a cache operation, healing the file once if it has gone bad.
 *
 * The whole safety contract lives here: any throw is swallowed and reported as
 * a miss, so the caller falls back to Postgres. One repair attempt is made per
 * operation, because a transient error (a locked file, a full disk) should not
 * cost us the cache permanently.
 */
async function withCache<T>(op: (c: LiteClient) => Promise<T>): Promise<T | null> {
  const c = await liteClient();
  if (c) {
    try {
      return await op(c);
    } catch {
      // The file is bad. Fall through to the repair below.
    }
  }
  // Repair whether the *open* failed or the *operation* did. Opening a corrupt
  // file fails inside liteClient, so a version that only repaired on an
  // operation error never rebuilt it at all — the cache stayed dead until the
  // process restarted, which is the exact failure this contract forbids.
  //
  // Rate-limited: a cache that is unavailable for a reason no rebuild can fix
  // (no generated client, no data directory) must not turn every request into a
  // delete-and-retry.
  if (Date.now() - lastRepairAt < RETRY_BACKOFF_MS) return null;
  lastRepairAt = Date.now();
  const healed = await rebuildCache();
  if (!healed) return null;
  try {
    return await op(healed);
  } catch {
    return null;
  }
}

/** Create the mirror tables. Plain DDL matching the Prisma models. */
async function ensureCacheTables(c: LiteClient): Promise<void> {
  const raw = (c as unknown as { $executeRawUnsafe(q: string): Promise<unknown> }).$executeRawUnsafe;
  await raw.call(
    c,
    `CREATE TABLE IF NOT EXISTS "SongLike" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "trackId" TEXT NOT NULL, "title" TEXT, "artist" TEXT, "album" TEXT, "createdAt" DATETIME NOT NULL, CONSTRAINT "SongLike_userId_trackId_key" UNIQUE ("userId", "trackId"))`
  );
  await raw.call(
    c,
    `CREATE INDEX IF NOT EXISTS "SongLike_trackId_createdAt_idx" ON "SongLike"("trackId", "createdAt")`
  );
  await raw.call(
    c,
    `CREATE TABLE IF NOT EXISTS "SongLinkCache" ("trackId" TEXT NOT NULL PRIMARY KEY, "spotifyUrl" TEXT, "appleMusicUrl" TEXT, "explicit" INTEGER, "resolvedAt" DATETIME NOT NULL)`
  );
  // Session gate mirror. tokenHash is an HMAC of the session token, never the
  // token itself, so this file holds no usable credential; the display fields
  // are encrypted exactly as they are in Postgres. validUntil is when the row
  // must be revalidated against Postgres.
  // sessionExpires/validUntil are TEXT on purpose. They hold epoch milliseconds
  // (~1.8e12), and Prisma's SQLite connector maps a declared INTEGER to a 32-bit
  // int — reading one back fails with an opaque "raw query failed" and no
  // column named. TEXT round-trips the value exactly; the reader parses it.
  await reconcileSessionTable(c);
}

/**
 * Create the session mirror, rebuilding it if its shape is stale.
 *
 * A cache is the one table here we are free to throw away, because nothing in it
 * is the record of anything — Postgres holds that. So a schema change does not
 * need a migration: if the columns are not what we expect, the table is dropped
 * and recreated, and the next request repopulates it from Postgres.
 *
 * `CREATE TABLE IF NOT EXISTS` alone cannot do this — it leaves an old table in
 * place, and the first query naming a new column then fails with an opaque
 * "no such column" on a cache that should be disposable.
 */
// sessionExpires/validUntil are TEXT on purpose: they hold epoch milliseconds
// (~1.8e12) and Prisma's SQLite connector maps a declared INTEGER to a 32-bit
// int, which overflows on read with a bare "raw query failed".
const SESSION_TABLE_DDL =
  `CREATE TABLE "SessionCache" ("tokenHash" TEXT NOT NULL PRIMARY KEY, ` +
  `"userId" TEXT NOT NULL, "sessionExpires" TEXT NOT NULL, "validUntil" TEXT NOT NULL, ` +
  `"isApproved" INTEGER NOT NULL, "isAdmin" INTEGER NOT NULL, ` +
  `"canUseDj" INTEGER NOT NULL, "canApprove" INTEGER NOT NULL, "canUseSkills" INTEGER NOT NULL, ` +
  `"nameEnc" TEXT, "nicknameEnc" TEXT, "emailEnc" TEXT, "email" TEXT)`;

const SESSION_COLUMNS = [
  "tokenHash", "userId", "sessionExpires", "validUntil",
  "isApproved", "isAdmin", "canUseDj", "canApprove", "canUseSkills",
  "nameEnc", "nicknameEnc", "emailEnc", "email",
] as const;

async function reconcileSessionTable(c: LiteClient): Promise<void> {
  const exec = (c as unknown as { $executeRawUnsafe: (q: string) => Promise<unknown> }).$executeRawUnsafe.bind(c);
  const read = (c as unknown as { $queryRawUnsafe: (q: string) => Promise<unknown> }).$queryRawUnsafe.bind(c);
  await exec(SESSION_TABLE_DDL.replace('CREATE TABLE "SessionCache"', 'CREATE TABLE IF NOT EXISTS "SessionCache"'));
  const info = (await read(`PRAGMA table_info("SessionCache")`)) as any[];
  const have = new Set((info ?? []).map((r) => r?.name));
  const missing = SESSION_COLUMNS.filter((col) => !have.has(col));
  if (missing.length === 0) return;
  // Disposable: drop and rebuild rather than migrate.
  await exec(`DROP TABLE "SessionCache"`);
  await exec(SESSION_TABLE_DDL);
}

// ---- SongLinkCache: SQLite read-through, write-back ----

export type LinkRow = {
  trackId: string;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  explicit: boolean | null;
};

export async function liteGetLink(trackId: string): Promise<LinkRow | null> {
  const c = await liteClient();
  if (!c) return null;
  try {
    return (await c.songLinkCache.findUnique({ where: { trackId } })) as unknown as LinkRow | null;
  } catch {
    return null;
  }
}

export async function litePutLink(row: LinkRow): Promise<boolean> {
  const c = await liteClient();
  if (!c) return false;
  try {
    await c.songLinkCache.upsert({
      where: { trackId: row.trackId },
      update: { spotifyUrl: row.spotifyUrl, appleMusicUrl: row.appleMusicUrl, explicit: row.explicit },
      create: { ...row, resolvedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

// ---- SongLike: SQLite mirror + merged reads ----

export type LikeRow = {
  id: string;
  userId: string;
  trackId: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  createdAt: Date;
};

export async function liteListMine(userId: string): Promise<LikeRow[]> {
  const c = await liteClient();
  if (!c) return [];
  try {
    return (await c.songLike.findMany({ where: { userId } })) as unknown as LikeRow[];
  } catch {
    return [];
  }
}

export async function liteListByTrack(trackId: string): Promise<LikeRow[]> {
  const c = await liteClient();
  if (!c) return [];
  try {
    return (await c.songLike.findMany({ where: { trackId } })) as unknown as LikeRow[];
  } catch {
    return [];
  }
}

/** Buffer a like. Returns the row (for the response) or null when uncached. */
export async function litePutLike(data: {
  userId: string;
  trackId: string;
  title?: string;
  artist?: string;
  album?: string;
}): Promise<LikeRow | null> {
  const c = await liteClient();
  if (!c) return null;
  try {
    const row = (await c.songLike.upsert({
      where: { userId_trackId: { userId: data.userId, trackId: data.trackId } },
      update: { title: data.title, artist: data.artist, album: data.album },
      create: { userId: data.userId, trackId: data.trackId, title: data.title, artist: data.artist, album: data.album },
    })) as unknown as LikeRow;
    return row;
  } catch {
    return null;
  }
}

/** Remove a buffered like. Postgres deletion stays the caller's job. */
export async function liteDeleteLike(userId: string, trackId: string): Promise<void> {
  const c = await liteClient();
  if (!c) return;
  try {
    await c.songLike.deleteMany({ where: { userId, trackId } });
  } catch {}
  invalidateTrackCache(trackId);
}

/** Merge Postgres rows with unflushed SQLite rows, Postgres winning ties. */
export function mergeLikeRows<T extends { id: string }>(pgRows: T[], liteRows: T[]): T[] {
  const seen = new Set(pgRows.map((r) => r.id));
  const merged = [...pgRows];
  for (const r of liteRows) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push(r);
    }
  }
  return merged;
}

function getTrackCache(trackId: string): unknown[] | null {
  const hit = trackCache.get(trackId);
  if (hit && Date.now() - hit.at < TRACK_CACHE_TTL_MS) return hit.body;
  trackCache.delete(trackId);
  return null;
}

function setTrackCache(trackId: string, body: unknown[]): void {
  trackCache.set(trackId, { at: Date.now(), body });
}

export function invalidateTrackCache(trackId: string): void {
  trackCache.delete(trackId);
}

/** Display slice for an unflushed liker: memory, then one Postgres read. */
export async function resolveLikeUser(userId: string): Promise<LikeUser> {
  const hit = userCache.get(userId);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;
  let user: LikeUser = null;
  try {
    user = (await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, nickname: true, image: true, hideLikeName: true },
    })) as unknown as LikeUser;
  } catch {
    user = null;
  }
  if (userCache.size >= USER_CACHE_MAX) {
    const oldest = userCache.keys().next();
    if (!oldest.done) userCache.delete(oldest.value);
  }
  userCache.set(userId, { at: Date.now(), user });
  return user;
}

/**
 * The track-likes list with the join intact: Postgres rows (with users) plus
 * unflushed SQLite rows (users resolved and masked by the caller), served
 * from a short memory cache so the 15s poll costs nothing. Invalidated on
 * every tap.
 */
export async function liteTrackLikes<T>(
  trackId: string,
  direct: () => Promise<T[]>,
  attachUser: (row: LikeRow, user: LikeUser) => T,
  isId: (row: T) => string
): Promise<T[]> {
  if (!(await liteEnabled())) return direct();
  const hit = getTrackCache(trackId);
  if (hit) return hit as T[];
  const [pgRows, liteRows] = await Promise.all([direct().catch((): T[] => []), liteListByTrack(trackId)]);
  const seen = new Set(pgRows.map(isId));
  const merged = [...pgRows];
  for (const r of liteRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(attachUser(r, await resolveLikeUser(r.userId)));
  }
  setTrackCache(trackId, merged);
  return merged;
}

// ---- Flush: SQLite → Postgres, every N minutes ----

export type FlushResult = { likes: number; links: number; errors: string[] };

export async function liteFlush(): Promise<FlushResult> {
  const out: FlushResult = { likes: 0, links: 0, errors: [] };
  const c = await liteClient();
  if (!c) {
    out.errors.push("no cache database");
    return out;
  }
  // Drained only after Postgres confirms the write, never before: a row removed
  // from the cache and then lost to a failed upsert would be gone from both
  // stores. Everything the loop cannot push stays put and is retried.
  const settledLikes: { id: string }[] = [];
  const settledLinks: string[] = [];
  let likes: LikeRow[] = [];
  let links: LinkRow[] = [];
  try {
    [likes, links] = await Promise.all([
      c.songLike.findMany(),
      c.songLinkCache.findMany(),
    ]);
  } catch (e) {
    out.errors.push(`read cache: ${(e as Error)?.message || "unknown"}`.slice(0, 160));
    return out;
  }
  for (const r of likes) {
    try {
      await prisma.songLike.upsert({
        where: { userId_trackId: { userId: r.userId, trackId: r.trackId } },
        update: { title: r.title, artist: r.artist, album: r.album },
        // Same id and timestamp: the flush converges stores, never forks them.
        create: {
          id: r.id,
          userId: r.userId,
          trackId: r.trackId,
          title: r.title,
          artist: r.artist,
          album: r.album,
          createdAt: r.createdAt,
        },
      });
      settledLikes.push({ id: r.id });
      out.likes++;
    } catch (e) {
      out.errors.push(`like ${r.trackId}: ${(e as Error)?.message || "unknown"}`.slice(0, 160));
    }
  }
  for (const r of links) {
    try {
      await prisma.songLinkCache.upsert({
        where: { trackId: r.trackId },
        update: { spotifyUrl: r.spotifyUrl, appleMusicUrl: r.appleMusicUrl, explicit: r.explicit },
        create: { trackId: r.trackId, spotifyUrl: r.spotifyUrl, appleMusicUrl: r.appleMusicUrl, explicit: r.explicit },
      });
      settledLinks.push(r.trackId);
      out.links++;
    } catch (e) {
      out.errors.push(`link ${r.trackId}: ${(e as Error)?.message || "unknown"}`.slice(0, 160));
    }
  }

  // Postgres is canonical now, so the mirror drops what it confirmed. Without
  // this the cache never empties and every flush re-pushes the same rows for
  // ever — which costs a query per row per interval and, on a free tier, holds
  // the database awake on a timer that never goes quiet.
  if (settledLikes.length > 0) {
    await c.songLike.deleteMany({ where: { id: { in: settledLikes.map((r) => r.id) } } }).catch((e) => {
      out.errors.push(`drain likes: ${(e as Error)?.message || "unknown"}`.slice(0, 160));
    });
  }
  if (settledLinks.length > 0) {
    await c.songLinkCache.deleteMany({ where: { trackId: { in: settledLinks } } }).catch((e) => {
      out.errors.push(`drain links: ${(e as Error)?.message || "unknown"}`.slice(0, 160));
    });
  }
  return out;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastFlushAt = 0;

/** Every minute, flush when due. Zero queries while disabled (see module note). */
export function startLiteFlushScheduler(): void {
  if (flushTimer) return;
  const loop = async () => {
    try {
      // File first (free local read): the admin save lands here within a
      // minute with no Postgres involved. Postgres only when neither memory
      // nor disk knows anything (first boot).
      const cfg = readLiteConfigFile() ?? memCfg ?? (await refreshLiteConfig());
      memCfg = cfg;
      // Non-Postgres stations hold no Postgres debt: nothing to flush, and
      // the loop stays query-free (the test hook still forces the path).
      const postgres =
        process.env.LITE_CACHE_FORCE === "1" || providerFromEnv() === "postgresql";
      if (postgres && cfg?.enabled && Date.now() - lastFlushAt >= cfg.minutes * 60 * 1000) {
        // No configuration re-read here, and that is the whole point.
        //
        // The line above already resolved the config from the local mirror, and
        // the admin save writes that mirror, so it is current by construction.
        // Re-reading from Postgres on every flush was defensive against a change
        // made outside the panel — and it cost one query per interval. At a
        // 20-minute interval against a sleep window of about fifteen minutes,
        // that is not a safety net but a heartbeat: it guaranteed the database
        // could never accumulate enough idle time to stop running, which is the
        // one thing this whole feature exists to achieve.
        if (cfg.enabled) {
          const res = await liteFlush().catch((e) => ({ likes: 0, links: 0, errors: [String(e?.message || e).slice(0, 160)] }));
          lastFlushAt = Date.now();
          if (res.errors.length > 0) {
            console.warn(`[lite-cache] flush: ${res.likes} likes, ${res.links} links, ${res.errors.length} errors (first: ${res.errors[0]})`);
          } else if (res.likes + res.links > 0) {
            console.log(`[lite-cache] flushed ${res.likes} likes, ${res.links} links to Postgres`);
          }
        }
      }
    } catch (e) {
      console.warn("[lite-cache] flush loop failed:", e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150));
    } finally {
      flushTimer = setTimeout(loop, 60 * 1000);
    }
  };
  loop();
}

// ---- SessionCache: the gate, mirrored so a request costs no database ----
//
// Everything here goes through withCache, so a missing, corrupt or unreadable
// cache file is a miss rather than an error. The caller then asks Postgres,
// which is the real database. That is the whole contract: this file is
// disposable, and throwing it away must cost nothing but one revalidation.

/** Stored shape of a cached session verdict. */
export type SessionRow = {
  userId: string;
  sessionExpires: number;
  isApproved: boolean;
  isAdmin: boolean;
  canUseDj: boolean;
  canApprove: boolean;
  canUseSkills: boolean;
  name: string | null;
  nickname: string | null;
  email: string | null;
  emailEnc: string | null;
};

/** The permissions a verdict carries, for a targeted write-through. */
export type PermissionFlags = {
  isApproved?: boolean;
  isAdmin?: boolean;
  canUseDj?: boolean;
  canApprove?: boolean;
  canUseSkills?: boolean;
};

/**
 * A SQL literal, escaped for SQLite.
 *
 * Tagged templates are the usual way to parameterise raw SQL, but Prisma does
 * not support them on SQLite — they need the extended query protocol, so
 * `$queryRaw`/`$executeRaw` fail there with an empty P2010. Hence
 * `$queryRawUnsafe`, and hence the obligation to escape properly.
 *
 * Two mistakes are specifically avoided here. JSON.stringify is not a
 * substitution for a SQL literal: SQLite reads "double quotes" as an
 * *identifier*, so a WHERE clause quietly became a column comparison and every
 * session read failed. And the quoting is SQL's, not JSON's — a single quote is
 * doubled, which is the only escaping SQLite recognises inside a string.
 *
 * Callers pass values, never fragments, so this is the single place where a
 * value can reach the statement text.
 */
const lit = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
};

const query = (c: LiteClient) =>
  (c as unknown as { $queryRawUnsafe: (q: string) => Promise<unknown> }).$queryRawUnsafe.bind(c);
const execute = (c: LiteClient) =>
  (c as unknown as { $executeRawUnsafe: (q: string) => Promise<unknown> }).$executeRawUnsafe.bind(c);

/**
 * Hash a session token into a cache key.
 *
 * HMAC, not the token. The file is on local disk with ordinary permissions, and
 * a session token is a bearer credential: anyone who could read this file would
 * otherwise be able to impersonate every cached session. Postgres stores the
 * token in plaintext, so this is strictly better than the record it mirrors.
 *
 * Returns null when no key is configured, which makes the cache unusable rather
 * than unsafe — the caller falls back to Postgres.
 */
export async function sessionTokenHash(token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const crypto = await import("node:crypto");
    const raw = process.env.PII_ENCRYPTION_KEY;
    if (!raw) return null;
    const key = /^[0-9a-f]{64}$/i.test(raw.trim())
      ? Buffer.from(raw.trim(), "hex")
      : Buffer.from(raw.trim(), "base64");
    if (key.length !== 32) return null;
    return crypto.createHmac("sha256", key).update(`session:${token}`).digest("hex");
  } catch {
    return null;
  }
}

/** The cached verdict for a token, or null when absent or past its revalidation. */
export async function liteGetSession(tokenHash: string, now = Date.now()): Promise<SessionRow | null> {
  if (!tokenHash) return null;
  return withCache(async (c) => {
    const rows = (await query(c)(
      `SELECT "userId","sessionExpires","validUntil","isApproved","isAdmin","canUseDj","canApprove","canUseSkills","nameEnc","nicknameEnc","emailEnc","email" ` +
      `FROM "SessionCache" WHERE "tokenHash" = ${lit(tokenHash)}`
    )) as any[];
    const r = rows?.[0];
    if (!r) return null;
    // An expired session and a stale verdict are both misses, so the caller
    // revalidates against Postgres rather than trusting this row.
    if (Number(r.sessionExpires) <= now || Number(r.validUntil) <= now) return null;
    const { dec } = await import("./pii");
    return {
      userId: String(r.userId),
      sessionExpires: Number(r.sessionExpires),
      isApproved: Number(r.isApproved) === 1,
      isAdmin: Number(r.isAdmin) === 1,
      canUseDj: Number(r.canUseDj) === 1,
      canApprove: Number(r.canApprove) === 1,
      canUseSkills: Number(r.canUseSkills) === 1,
      name: dec(r.nameEnc),
      nickname: dec(r.nicknameEnc),
      email: r.email ?? null,
      emailEnc: r.emailEnc ?? null,
    } satisfies SessionRow;
  });
}

/**
 * Store a verdict. Best-effort by construction: a cache that cannot be written
 * to must not fail the request that produced the answer.
 */
export async function litePutSession(
  tokenHash: string,
  row: Omit<SessionRow, "name" | "nickname" | "emailEnc"> & {
    name?: string | null;
    nickname?: string | null;
    emailEnc?: string | null;
  },
  validUntil: number = Date.now() + liteSessionMinutes() * 60_000
): Promise<boolean> {
  if (!tokenHash) return false;
  const wrote = await withCache(async (c) => {
    const { enc } = await import("./pii");
    // Only a verdict still inside the session's own lifetime is worth keeping;
    // anything already expired would be handed back as live.
    if (row.sessionExpires <= Date.now()) return false;
    await execute(c)(
      `INSERT INTO "SessionCache" ("tokenHash","userId","sessionExpires","validUntil","isApproved","isAdmin","canUseDj","canApprove","canUseSkills","nameEnc","nicknameEnc","emailEnc","email") ` +
      `VALUES (${lit(tokenHash)}, ${lit(row.userId)}, ${lit(String(Number(row.sessionExpires)))}, ${lit(String(Number(validUntil)))}, ` +
      `${row.isApproved ? 1 : 0}, ${row.isAdmin ? 1 : 0}, ${row.canUseDj ? 1 : 0}, ${row.canApprove ? 1 : 0}, ${row.canUseSkills ? 1 : 0}, ` +
      `${lit(enc(row.name ?? null))}, ${lit(enc(row.nickname ?? null))}, ` +
      `${lit(row.emailEnc ?? null)}, ${lit(row.email ?? null)}) ` +
      `ON CONFLICT("tokenHash") DO UPDATE SET ` +
      `"userId"=excluded."userId","sessionExpires"=excluded."sessionExpires","validUntil"=excluded."validUntil",` +
      `"isApproved"=excluded."isApproved","isAdmin"=excluded."isAdmin",` +
      `"canUseDj"=excluded."canUseDj","canApprove"=excluded."canApprove","canUseSkills"=excluded."canUseSkills",` +
      `"nameEnc"=excluded."nameEnc","nicknameEnc"=excluded."nicknameEnc","emailEnc"=excluded."emailEnc","email"=excluded."email"`
    );
    return true;
  });
  return wrote === true;
}

/** Forget one token, or every cached session when given no token. */
export async function liteDropSession(tokenHash?: string): Promise<void> {
  await withCache(async (c) => {
    if (tokenHash) {
      await execute(c)(`DELETE FROM "SessionCache" WHERE "tokenHash" = ${lit(tokenHash)}`);
    } else {
      await execute(c)(`DELETE FROM "SessionCache"`);
    }
    return true;
  });
}

/** Drop every cached verdict for one user, whatever token they signed in with. */
export async function liteDropSessionsForUser(userId: string): Promise<void> {
  if (!userId) return;
  await withCache(async (c) => {
    await execute(c)(`DELETE FROM "SessionCache" WHERE "userId" = ${lit(userId)}`);
    return true;
  });
}

/**
 * Write a permission change straight into every cached verdict for a user.
 *
 * This is the difference between "revoked, but the listener keeps their access
 * until the next revalidation" and "revoked, immediately". The alternative —
 * dropping the rows — is correct but costs a Postgres read on the very next
 * request, which is the one thing this cache exists to avoid.
 *
 * Only the named columns move. The deadline, the identity and the encrypted
 * display fields are deliberately untouched: a permission change says nothing
 * about when the session expires or what the listener is called, and rewriting
 * them would risk widening a verdict's life.
 *
 * Every token the user holds is updated, so a change applies on all their
 * devices at once.
 */
export async function liteUpdateSessionPermissions(
  userId: string,
  flags: PermissionFlags
): Promise<boolean> {
  if (!userId) return false;
  const cols = Object.keys(flags).filter(
    (k): k is keyof PermissionFlags =>
      k === "isApproved" || k === "isAdmin" || k === "canUseDj" || k === "canApprove" || k === "canUseSkills"
  );
  if (cols.length === 0) return false;
  const assignments = cols.map((c) => `"${c}" = ${flags[c] ? 1 : 0}`).join(", ");
  const wrote = await withCache(async (c) => {
    await execute(c)(`UPDATE "SessionCache" SET ${assignments} WHERE "userId" = ${lit(userId)}`);
    return true;
  });
  return wrote === true;
}
