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
} as const;

export const LITE_DEFAULT_MINUTES = 20;
const LITE_MIN_MINUTES = 5;
const LITE_MAX_MINUTES = 240;

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
let memCfg: { enabled: boolean; minutes: number } | null = null;

export async function refreshLiteConfig(): Promise<{ enabled: boolean; minutes: number }> {
  let enabled = false;
  let minutes = LITE_DEFAULT_MINUTES;
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [LITE_KEYS.enabled, LITE_KEYS.flushMinutes] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    enabled = get(LITE_KEYS.enabled) === "true";
    const m = Math.floor(Number(get(LITE_KEYS.flushMinutes)));
    if (Number.isFinite(m)) minutes = Math.min(LITE_MAX_MINUTES, Math.max(LITE_MIN_MINUTES, m));
  } catch {
    // Unreadable database: keep the last known answer (or off).
  }
  memCfg = { enabled, minutes };
  writeLiteConfigFile(memCfg);
  return memCfg;
}

export function setLiteConfigLocal(enabled: boolean, minutes: number): void {
  memCfg = { enabled, minutes };
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

function readLiteConfigFile(): { enabled: boolean; minutes: number } | null {
  try {
    if (!existsSync(liteConfigPath())) return null;
    const d = JSON.parse(readFileSync(liteConfigPath(), "utf8")) as { enabled?: unknown; minutes?: unknown };
    if (typeof d.enabled !== "boolean") return null;
    const m = Math.floor(Number(d.minutes));
    return {
      enabled: d.enabled,
      minutes: Number.isFinite(m) ? Math.min(LITE_MAX_MINUTES, Math.max(LITE_MIN_MINUTES, m)) : LITE_DEFAULT_MINUTES,
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

function cacheDbUrl(): string {
  const override = process.env.LITE_CACHE_DB_PATH;
  if (override) return override.startsWith("file:") ? override : `file:${override}`;
  return `file:${process.cwd()}/data/lite-cache.db`;
}

let lite: LiteClient | null = null;
let liteFailed = false;

async function liteClient(): Promise<LiteClient | null> {
  if (lite) return lite;
  if (liteFailed) return null;
  try {
    const mod = await import("../prisma/lite-client/index.js");
    const c = new mod.PrismaClient({ datasources: { db: { url: cacheDbUrl() } } });
    await ensureCacheTables(c as unknown as LiteClient);
    lite = c as unknown as LiteClient;
    return lite;
  } catch {
    // No generated files, no data dir, locked disk — the caller falls back
    // to direct Postgres. A broken cache must never break the feature.
    liteFailed = true;
    return null;
  }
}

/** Create the two mirror tables. Plain DDL matching the Prisma models. */
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
}

/** Forget everything (tests, and the admin switch-off path keeps it simple). */
export function resetLiteState(): void {
  lite = null;
  liteFailed = false;
  trackCache.clear();
  userCache.clear();
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
        await refreshLiteConfig();
        const fresh = memCfg;
        if (fresh?.enabled) {
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
