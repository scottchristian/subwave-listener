import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type ActivitySnapshot = { signedIn: string[]; listening: string[]; devices: string[] };

type Kind = "signed-in" | "stream" | "device";
type RecordData = { version: 1; kind: Kind; id: string; at: number; userId?: string };
type Entry = { name: string; stat: Stats; data: RecordData; temporary: boolean };
const TTL: Record<Kind, number> = { "signed-in": 120_000, stream: 30_000, device: 90_000 };
const MAX_TTL = Math.max(...Object.values(TTL));
const TOUCH_MS = 15_000;
const MAX_BYTES = 2048;
const MAX_FILES = 4096; // Includes crash-left temporary files; never evict live identities.
const FILE_RE = /^(signed-in|stream|device)-[a-f0-9]{64}\.json$/;
const TEMP_RE = /^(.*\.json)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validTime = (now: number) => Number.isSafeInteger(now) && now >= 0;
const codeOf = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const directory = () => path.resolve(process.env.STATION_STATS_DIR || path.join(process.cwd(), "data", "station-stats"));
const filename = (kind: Kind, id: string) => `${kind}-${createHash("sha256").update(`${kind}\0${id}`).digest("hex")}.json`;
const unavailable = () => Object.assign(new Error("Station activity storage is unavailable."), { code: "STATION_ACTIVITY_UNAVAILABLE" });

// Next instrumentation and route bundles can contain separate module copies.
// Only serialization/error health is shared in memory; observations ALWAYS come
// from disk (including after restart). One PM2 writer process is assumed.
type State = { queue: Promise<void>; failures: Map<string, Partial<Record<Kind, number>>> };
const KEY = Symbol.for("subwave.station-activity.v1");
const globals = globalThis as typeof globalThis & { [KEY]?: State };
const state = globals[KEY] ??= { queue: Promise.resolve(), failures: new Map() };
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const result = state.queue.then(fn);
  state.queue = result.then(() => {}, () => {});
  return result;
}

function noteFailure(dir: string, kind: Kind, now: number) {
  const failures = state.failures.get(dir) || {};
  // A later successful heartbeat from another identity must not clear a lost
  // observation. Conservatively keep this channel unknown for its full TTL.
  failures[kind] = Math.max(failures[kind] || 0, (validTime(now) ? now : Date.now()) + TTL[kind]);
  state.failures.set(dir, failures);
}
function checkFailures(dir: string, now: number) {
  const failures = state.failures.get(dir);
  if (!failures) return;
  for (const kind of Object.keys(failures) as Kind[]) {
    if (now < failures[kind]!) throw unavailable();
  }
  state.failures.delete(dir);
}
function mutate(dir: string, kind: Kind, now: number, fn: () => Promise<void>): Promise<void> {
  return serial(async () => {
    try { await fn(); }
    catch {
      noteFailure(dir, kind, now);
      throw unavailable(); // Never expose a path, identity or original error to route logs.
    }
  });
}

function owned(stat: Stats) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}
function regular(stat: Stats) {
  if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || !(stat.mode & 0o400) || stat.size < 1 || stat.size > MAX_BYTES) throw unavailable();
}
function same(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
async function statOrMissing(file: string): Promise<Stats | null> {
  try { return await fs.lstat(file); }
  catch (e) { if (codeOf(e) === "ENOENT") return null; throw e; }
}
async function storage(dir: string, create: boolean): Promise<string | null> {
  // The configured root's parents are trusted configuration. Never follow a
  // symlink at the root, the private live directory, or any owned file.
  let root = await statOrMissing(dir);
  if (!root && create) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    root = await fs.lstat(dir);
  }
  if (!root) return null;
  if (!root.isDirectory() || !owned(root)) throw unavailable();
  const live = path.join(dir, "activity-live");
  let stat = await statOrMissing(live);
  if (!stat && create) {
    await fs.mkdir(live, { mode: 0o700 });
    stat = await fs.lstat(live);
  }
  if (!stat) return null;
  if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077) !== 0 || (stat.mode & 0o500) !== 0o500) throw unavailable();
  return live;
}
async function names(live: string): Promise<string[]> {
  const out: string[] = [];
  const handle = await fs.opendir(live);
  for await (const entry of handle) {
    const base = TEMP_RE.exec(entry.name)?.[1] || entry.name;
    // Unknown data is not a healthy zero, and is never a pruning target.
    if (!FILE_RE.test(base) || !entry.isFile() || out.length >= MAX_FILES) throw unavailable();
    out.push(entry.name);
  }
  return out;
}
async function readEntry(live: string, name: string): Promise<Entry> {
  const file = path.join(live, name);
  const before = await fs.lstat(file);
  regular(before);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let text: string;
  try {
    const stat = await handle.stat();
    regular(stat);
    if (!same(before, stat)) throw unavailable();
    // Bounded even if another process grows a file after lstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size || !same(stat, await handle.stat())) throw unavailable();
    text = bytes.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
  const data = JSON.parse(text) as RecordData;
  const base = TEMP_RE.exec(name)?.[1] || name;
  if (!data || data.version !== 1 || !Object.hasOwn(TTL, data.kind) || !validId(data.id) || !validTime(data.at)
    || base !== filename(data.kind, data.id)
    || (data.kind === "stream" ? !validId(data.userId) : data.userId !== undefined)
    || Object.keys(data).sort().join(",") !== (data.kind === "stream" ? "at,id,kind,userId,version" : "at,id,kind,version")) throw unavailable();
  return { name, stat: before, data, temporary: base !== name };
}
async function unchanged(live: string, entry: Entry) {
  const stat = await fs.lstat(path.join(live, entry.name));
  regular(stat);
  if (!same(entry.stat, stat)) throw unavailable();
}
async function expiredTemporary(live: string, name: string, now: number) {
  if (!TEMP_RE.test(name)) return false;
  try { return now - (await fs.lstat(path.join(live, name))).mtimeMs >= MAX_TTL; }
  catch { return false; }
}
async function scan(live: string, now: number): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const name of await names(live)) {
    try {
      const entry = await readEntry(live, name);
      if (entry.data.at > now) throw unavailable();
      entries.push(entry);
    } catch (error) {
      // An interrupted write can leave a partial temp file. Once older than every
      // TTL it cannot describe a live identity, so ignore it for reads (and keep
      // the file for inspection) instead of reporting unknown forever.
      if (await expiredTemporary(live, name, now)) continue;
      throw error;
    }
  }
  return entries;
}
async function prune(live: string, entries: Entry[], now: number) {
  for (const entry of entries) {
    const ttl = TTL[entry.data.kind];
    // An old payload in a newly replaced file is NOT permission to delete it.
    // Likewise future mtimes, corrupt files, links and unknown names survive.
    if (now - entry.data.at < ttl || now - entry.stat.mtimeMs < ttl) continue;
    await unchanged(live, entry);
    await fs.unlink(path.join(live, entry.name));
  }
}
async function persist(dir: string, data: RecordData) {
  if (!validId(data.id) || !validTime(data.at) || (data.kind === "stream" && !validId(data.userId))) throw unavailable();
  const live = (await storage(dir, true))!;
  const name = filename(data.kind, data.id);
  const listed = await names(live);
  const previous = listed.includes(name) ? await readEntry(live, name) : null;
  if (previous && previous.data.userId !== data.userId) throw unavailable();
  // Late requests from other tabs must not move an identity backwards.
  if (previous && previous.data.at >= data.at) return;
  if (listed.length >= MAX_FILES) {
    await prune(live, (await scan(live, data.at)).filter((entry) => entry.name !== name), data.at);
    if ((await names(live)).length >= MAX_FILES) throw unavailable();
  }
  const temporary = `${name}.${randomUUID()}.tmp`;
  const tempFile = path.join(live, temporary);
  const handle = await fs.open(tempFile, "wx", 0o600);
  // A failed/partial write intentionally remains visible to readers as unknown.
  // Do not erase the only on-disk evidence of a failure during cleanup.
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally { await handle.close(); }
  if (previous) await unchanged(live, previous);
  await fs.rename(tempFile, path.join(live, name));
}

/** Fresh means age < TTL. A future timestamp is invalid, not extra lifetime. */
export async function readStationActivity(now: number, dir = directory()): Promise<ActivitySnapshot> {
  dir = path.resolve(dir);
  return serial(async () => {
    if (!validTime(now)) throw unavailable();
    checkFailures(dir, now);
    const result = { signedIn: new Set<string>(), listening: new Set<string>(), devices: new Set<string>() };
    const live = await storage(dir, false);
    // A store that was never written, or whose directory disappeared, is unknown.
    // Only an existing store with no fresh evidence is a measured zero.
    if (!live) throw unavailable();
    const entries = await scan(live, now); // Validate everything BEFORE pruning anything.
    for (const { data, temporary } of entries) {
      // A leftover temp file means a write never committed. Until its evidence
      // expires, report unknown rather than omit a potentially live identity.
      if (now - data.at >= TTL[data.kind]) continue;
      if (temporary) throw unavailable();
      if (data.kind === "device") result.devices.add(data.id);
      else {
        result.signedIn.add(data.kind === "stream" ? data.userId! : data.id);
        if (data.kind === "stream") result.listening.add(data.userId!);
      }
    }
    await prune(live, entries, now);
    return { signedIn: [...result.signedIn].sort(), listening: [...result.listening].sort(), devices: [...result.devices].sort() };
  });
}

/** Active authenticated app heartbeats, not the lifetime of a session cookie. */
export async function recordSignedIn(userId: string, now = Date.now()): Promise<void> {
  const dir = directory();
  return mutate(dir, "signed-in", now, () => persist(dir, { version: 1, kind: "signed-in", id: userId, at: now }));
}
export async function recordDeviceOnline(deviceId: string, now = Date.now()): Promise<void> {
  const dir = directory();
  return mutate(dir, "device", now, () => persist(dir, { version: 1, kind: "device", id: deviceId, at: now }));
}
export function trackAppStream(userId: string, streamId: string): { touch: (now?: number) => Promise<void>; stop: () => Promise<void> } {
  const dir = directory();
  let lastAttempt: number | undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  return {
    touch(now = Date.now()) {
      if (stopped || (lastAttempt !== undefined && validTime(now) && now - lastAttempt < TOUCH_MS)) return Promise.resolve();
      lastAttempt = now; // Reserve synchronously, before any I/O or another chunk.
      return mutate(dir, "stream", now, () => persist(dir, { version: 1, kind: "stream", id: streamId, userId, at: now }));
    },
    stop() {
      stopped = true; // A queued/late read must never recreate evidence after stop.
      if (lastAttempt === undefined) return Promise.resolve(); // No audio: no storage touches at all.
      return stopping ??= mutate(dir, "stream", lastAttempt, async () => {
        if (!validId(streamId) || !validId(userId)) throw unavailable();
        const live = await storage(dir, false);
        if (!live) return;
        const name = filename("stream", streamId);
        if (!await statOrMissing(path.join(live, name))) return;
        const entry = await readEntry(live, name);
        if (entry.data.userId !== userId) throw unavailable();
        await unchanged(live, entry);
        await fs.unlink(path.join(live, name));
      });
    },
  };
}
