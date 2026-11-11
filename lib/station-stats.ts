import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StationStatsResponse } from "./station-stats-types";
import type { ActivitySnapshot } from "./station-activity";

export const SAMPLE_INTERVAL_MS = 60_000;
export const MAX_HOLD_MS = 90_000;
export const CONFIG_CACHE_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 32;
// 1440 minute samples now include private IDs, not just scalar station counts.
// Both limits fail explicitly; never silently truncate a population or history.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ACTIVITY_IDS = 1000;
const FILE_RE = /^station-stats-(\d{4}-\d{2}-\d{2})\.json$/;
const TEMP_RE = /^station-stats-(\d{4}-\d{2}-\d{2})\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const ISSUE_MESSAGES = {
  config_unavailable: "Station source configuration is unavailable.",
  now_playing_unavailable: "Now-playing observation failed.",
  state_unavailable: "Station state observation failed.",
  invalid_listeners: "Listener count is unavailable or invalid.",
  invalid_air_state: "On-air state is unavailable or invalid.",
} as const;
type Issue = keyof typeof ISSUE_MESSAGES;

export type StationObservation = {
  at: string;
  listeners: number | null;
  onAir: boolean | null;
  issues: Issue[];
  /** Absent: deployed pre-activity record. Null: activity observation failed. */
  activity?: ActivitySnapshot | null;
};
type DailyFile = {
  version: 1;
  day: string;
  trackingSince: string;
  activityTrackingSince?: string | null;
  timeZone: string | null;
  samples: StationObservation[];
};
type Archive = {
  samples: StationObservation[];
  trackingSince: string | null;
  activityTrackingSince?: string | null;
  timeZone: string | null;
  errors: string[];
};

const iso = (ms: number) => new Date(ms).toISOString();
const utcDay = (ms: number) => iso(ms).slice(0, 10);
const directory = () => path.resolve(process.env.STATION_STATS_DIR || path.join(process.cwd(), "data", "station-stats"));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
const validIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && iso(Date.parse(v)) === v;
export const validStationDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)
  && v.slice(0, 4) !== "0000" && Number.isFinite(Date.parse(v)) && utcDay(Date.parse(v)) === v;
const validDay = validStationDate;
export class StationStatsDateError extends Error {}
const earliest = (...values: (string | null | undefined)[]) => values.filter((v): v is string => !!v).sort()[0] ?? null;

function decodeActivity(raw: unknown): ActivitySnapshot {
  if (!isObject(raw) || Object.keys(raw).some((key) => !["signedIn", "listening", "devices"].includes(key))) {
    throw new Error("Invalid activity observation");
  }
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > MAX_ACTIVITY_IDS) throw new Error("Activity cardinality limit exceeded or invalid IDs");
    // Only opaque database IDs. No email addresses, display names or session payloads.
    if (!value.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      throw new Error("Invalid activity ID");
    }
    return [...new Set(value)].sort();
  };
  return { signedIn: ids(raw.signedIn), listening: ids(raw.listening), devices: ids(raw.devices) };
}
const codeOf = (e: unknown) => isObject(e) ? e.code : null;

export function validStationTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100 || /^[+-]/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function stationDateFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (ms: number) => {
    const parts = fmt.formatToParts(ms);
    return ["year", "month", "day"].map((key) => parts.find((part) => part.type === key)!.value.padStart(key === "year" ? 4 : 2, "0")).join("-");
  };
}

/** UTC is only a search anchor; Intl locates actual station calendar boundaries, including DST. */
export function stationDayBounds(now: number, timeZone: string, date?: string): { start: number; end: number } {
  const dateKey = stationDateFormatter(timeZone);
  const selected = date ?? dateKey(now);
  if (!validStationDate(selected)) throw new StationStatsDateError("Invalid station date.");
  const anchor = Date.parse(`${selected}T00:00:00.000Z`);
  const boundary = (after: boolean) => {
    let lo = anchor - 2 * DAY_MS;
    let hi = anchor + 2 * DAY_MS;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (after ? dateKey(mid) > selected : dateKey(mid) >= selected) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  return { start: boundary(false), end: boundary(true) };
}

function decodeDaily(raw: unknown, day: string): DailyFile {
  if (!isObject(raw) || raw.version !== 1 || raw.day !== day || !validIso(raw.trackingSince)
    || !(raw.activityTrackingSince === undefined || raw.activityTrackingSince === null || validIso(raw.activityTrackingSince))
    || !(raw.timeZone === null || validStationTimeZone(raw.timeZone))
    || !Array.isArray(raw.samples) || raw.samples.length > 1440) throw new Error("Invalid statistics file");
  let minute = -Infinity;
  const samples: StationObservation[] = raw.samples.map((s: unknown) => {
    if (!isObject(s) || !validIso(s.at) || s.at.slice(0, 10) !== day
      || !(s.listeners === null || validCount(s.listeners))
      || !(s.onAir === null || typeof s.onAir === "boolean")
      || !Array.isArray(s.issues) || s.issues.length > 5
      || !s.issues.every((v) => typeof v === "string" && Object.hasOwn(ISSUE_MESSAGES, v))) throw new Error("Invalid observation");
    const nextMinute = Math.floor(Date.parse(s.at) / SAMPLE_INTERVAL_MS);
    if (nextMinute <= minute || s.at < raw.trackingSince!) throw new Error("Invalid observation order");
    minute = nextMinute;
    return { at: s.at, listeners: s.listeners, onAir: s.onAir, issues: s.issues as Issue[],
      ...(Object.hasOwn(s, "activity") ? { activity: s.activity === null ? null : decodeActivity(s.activity) } : {}),
    };
  });
  const activityTrackingSince = earliest(raw.activityTrackingSince as string | null | undefined,
    samples.find((s) => s.activity != null)?.at);
  if (activityTrackingSince && activityTrackingSince < raw.trackingSince) throw new Error("Invalid activity tracking metadata");
  return { version: 1, day, trackingSince: raw.trackingSince, activityTrackingSince,
    timeZone: validStationTimeZone(raw.timeZone), samples };
}

async function readDaily(dir: string, day: string): Promise<DailyFile | null> {
  const file = path.join(dir, `station-stats-${day}.json`);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid or oversized statistics file");
    const contents = await fs.readFile(file);
    if (contents.length > MAX_FILE_BYTES) throw new Error("Statistics file size limit exceeded");
    return decodeDaily(JSON.parse(contents.toString("utf8")), day);
  } catch (e) {
    if (codeOf(e) === "ENOENT") return null;
    throw e;
  }
}

async function readArchive(dir: string, now: number): Promise<Archive> {
  const archive: Archive = { samples: [], trackingSince: null, timeZone: null, errors: [] };
  try {
    const cutoff = utcDay(now - (RETENTION_DAYS - 1) * DAY_MS);
    const today = utcDay(now);
    const days = (await fs.readdir(dir)).flatMap((name) => {
      const day = FILE_RE.exec(name)?.[1];
      return day && validDay(day) && day <= today ? [day] : [];
    }).sort();
    for (const day of days) {
      try {
        const file = await readDaily(dir, day);
        if (!file) continue;
        // Metadata is carried forward, so retention does not reset trackingSince.
        if (Date.parse(file.trackingSince) <= now) {
          if (!archive.trackingSince || file.trackingSince < archive.trackingSince) archive.trackingSince = file.trackingSince;
          if (file.timeZone) archive.timeZone = file.timeZone;
          if (file.activityTrackingSince && Date.parse(file.activityTrackingSince) <= now) {
            archive.activityTrackingSince = earliest(archive.activityTrackingSince, file.activityTrackingSince);
          }
        }
        if (day >= cutoff) archive.samples.push(...file.samples.filter((s) => Date.parse(s.at) <= now));
      } catch {
        archive.errors.push("Some station statistics data is unreadable.");
      }
    }
  } catch (e) {
    if (codeOf(e) !== "ENOENT") archive.errors.push("Station statistics storage is unreadable.");
  }
  return archive;
}

async function pruneFiles(dir: string, now: number): Promise<void> {
  const cutoff = utcDay(now - (RETENTION_DAYS - 1) * DAY_MS);
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const day = (FILE_RE.exec(entry.name) || TEMP_RE.exec(entry.name))?.[1];
    if (entry.isFile() && day && validDay(day) && day < cutoff) {
      await fs.unlink(path.join(dir, entry.name));
    }
  }
}

export async function persistStationObservation(
  sample: StationObservation,
  metadata: { timeZone: string | null; trackingSince: string; activityTrackingSince?: string | null },
  dir = directory(),
): Promise<void> {
  const now = Date.parse(sample.at);
  const day = utcDay(now);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Refuse to overwrite corrupt history: report a storage failure, not a new empty day.
  const previous = await readDaily(dir, day);
  const minute = Math.floor(now / SAMPLE_INTERVAL_MS);
  const samples = (previous?.samples || []).filter((s) => Math.floor(Date.parse(s.at) / SAMPLE_INTERVAL_MS) !== minute);
  samples.push(sample);
  samples.sort((a, b) => a.at.localeCompare(b.at));
  const file = decodeDaily({
    version: 1, day, trackingSince: previous?.trackingSince || metadata.trackingSince,
    activityTrackingSince: earliest(previous?.activityTrackingSince, metadata.activityTrackingSince),
    timeZone: validStationTimeZone(metadata.timeZone) || previous?.timeZone || null, samples,
  }, day);
  const contents = JSON.stringify(file);
  if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new Error("Statistics file size limit exceeded");
  const destination = path.join(dir, `station-stats-${day}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((e: unknown) => { if (codeOf(e) !== "ENOENT") throw e; });
  }
  await pruneFiles(dir, now);
}

export function summarizeStationStats(archive: Archive, now: number, requestedDate?: string): StationStatsResponse {
  if (requestedDate !== undefined && !validStationDate(requestedDate)) throw new StationStatsDateError("Invalid station date.");
  const recorded = archive.samples.filter((s) => Date.parse(s.at) <= now).sort((a, b) => a.at.localeCompare(b.at));
  const timeZone = validStationTimeZone(archive.timeZone);
  const dateKey = timeZone ? stationDateFormatter(timeZone) : null;
  const todayDate = dateKey ? dateKey(now) : null;
  // Without a known timezone, only reject dates future in every station timezone.
  if (requestedDate && requestedDate > (todayDate ?? utcDay(now + 14 * 3_600_000))) {
    throw new StationStatsDateError("Future station dates are not available.");
  }
  const date = requestedDate ?? todayDate;
  const isToday = date !== null && date === todayDate;
  const day = timeZone && date ? stationDayBounds(now, timeZone, date) : null;
  const until = day ? Math.min(now, day.end) : now;
  const samples = recorded.filter((s) => day ? (Date.parse(s.at) < day.end
    && Date.parse(s.at) + MAX_HOLD_MS > day.start) : requestedDate === undefined);
  const last = samples.at(-1);
  const stale = !last || ((!day || isToday) && now - Date.parse(last.at) > MAX_HOLD_MS);
  const currentActivity = !stale && last?.activity != null ? decodeActivity(last.activity) : null;
  const activityErrors = [...archive.errors];
  const errors = [...archive.errors];
  if (!last) errors.push("No station observations have been recorded.");
  else {
    if (stale) errors.push("Latest station observation is stale.");
    errors.push(...last.issues.map((issue) => ISSUE_MESSAGES[issue]));
  }
  if (!timeZone) errors.push("Station timezone is unavailable.");
  if (last?.activity === null) activityErrors.push("App activity observation failed.");
  if (!samples.some((s) => s.activity != null)) activityErrors.push("No app activity observations have been recorded for this day.");
  if (stale && last?.activity != null) activityErrors.push("Latest app activity observation is stale.");
  const cutoffDate = todayDate ? utcDay(Date.parse(`${todayDate}T00:00:00.000Z`) - (RETENTION_DAYS - 1) * DAY_MS) : null;
  const availableDates = dateKey ? [...new Set(recorded.map((s) => dateKey(Date.parse(s.at))))]
    .filter((key) => key >= cutoffDate! && key <= todayDate!).sort().reverse().slice(0, RETENTION_DAYS) : [];
  const response: StationStatsResponse = {
    generatedAt: iso(now), timeZone, date, todayDate, availableDates, isToday,
    dayStart: day ? iso(day.start) : null, dayEnd: day ? iso(day.end) : null,
    trackingSince: archive.trackingSince, lastSampleAt: last?.at || null, sampleIntervalSec: SAMPLE_INTERVAL_MS / 1000,
    current: { listeners: stale ? null : last.listeners, onAir: stale ? null : last.onAir, at: last?.at || null, stale },
    today: { airtimeSec: null, listenerSeconds: null, averageListeners: null, peakListeners: null,
      airtimeObservedSec: 0, listenerObservedSec: 0, elapsedSec: day ? Math.max(0, until - day.start) / 1000 : 0 },
    activity: {
      trackingSince: earliest(archive.activityTrackingSince, recorded.find((s) => s.activity != null)?.at),
      current: { signedIn: currentActivity?.signedIn.length ?? null, listening: currentActivity?.listening.length ?? null,
        devicesOnline: currentActivity?.devices.length ?? null },
      signedInSeconds: null, listeningSeconds: null, observedSec: 0, peakDevices: null, averageDevices: null,
      uniqueDevices: null, users: [], error: [...new Set(activityErrors)].join(" ") || null,
    },
    timeline: [], error: [...new Set(errors)].join(" ") || null,
  };
  if (day) {
    let cursor = day.start;
    let airtime = 0;
    let listenerSeconds = 0;
    let signedInSeconds = 0;
    let listeningSeconds = 0;
    let deviceSeconds = 0;
    let activityRecorded = false;
    const devices = new Set<string>();
    const users = new Map<string, StationStatsResponse["activity"]["users"][number]>();
    const add = (start: number, end: number, listeners: number | null, onAir: boolean | null, activity: ActivitySnapshot | null) => {
      if (end <= start) return;
      response.timeline.push({ at: iso(start), endAt: iso(end), listeners, onAir,
        signedIn: activity?.signedIn.length ?? null, listening: activity?.listening.length ?? null, devicesOnline: activity?.devices.length ?? null });
      const seconds = (end - start) / 1000;
      if (onAir !== null) {
        response.today.airtimeObservedSec += seconds;
        if (onAir) airtime += seconds;
      }
      if (listeners !== null) {
        response.today.listenerObservedSec += seconds;
        listenerSeconds += listeners * seconds;
      }
      if (activity) {
        response.activity.observedSec += seconds;
        signedInSeconds += activity.signedIn.length * seconds;
        listeningSeconds += activity.listening.length * seconds;
        deviceSeconds += activity.devices.length * seconds;
        for (const [ids, field] of [[activity.signedIn, "signedInSec"], [activity.listening, "listeningSec"]] as const) {
          for (const userId of ids) {
            const user = users.get(userId) ?? { userId, signedInSec: 0, listeningSec: 0 };
            user[field] += seconds;
            users.set(userId, user);
          }
        }
      }
    };
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const at = Date.parse(s.at);
      const start = Math.max(day.start, at);
      const end = Math.min(until, at + MAX_HOLD_MS, samples[i + 1] ? Date.parse(samples[i + 1].at) : Infinity);
      const activity = s.activity == null ? null : decodeActivity(s.activity);
      // A valid held point straddling midnight also counts; later-day points never do.
      if (end > start || at >= day.start) {
        if (s.listeners !== null) response.today.peakListeners = Math.max(response.today.peakListeners ?? 0, s.listeners);
        if (activity) {
          activityRecorded = true;
          response.activity.peakDevices = Math.max(response.activity.peakDevices ?? 0, activity.devices.length);
          for (const id of activity.devices) devices.add(id);
        }
      }
      if (end <= start) continue;
      if (start > cursor) add(cursor, start, null, null, null);
      add(start, end, s.listeners, s.onAir, activity);
      cursor = end;
    }
    add(cursor, until, null, null, null);
    const today = response.today;
    if (today.airtimeObservedSec > 0) today.airtimeSec = airtime;
    if (today.listenerObservedSec > 0) {
      today.listenerSeconds = listenerSeconds;
      today.averageListeners = listenerSeconds / today.listenerObservedSec;
    }
    if (response.activity.observedSec > 0) {
      response.activity.signedInSeconds = signedInSeconds;
      response.activity.listeningSeconds = listeningSeconds;
      response.activity.averageDevices = deviceSeconds / response.activity.observedSec;
    }
    response.activity.uniqueDevices = activityRecorded ? devices.size : null;
    response.activity.users = [...users.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }
  return response;
}

export async function getStationStats(opts: { now?: number; dir?: string; date?: string } = {}): Promise<StationStatsResponse> {
  if (opts.date !== undefined && !validStationDate(opts.date)) throw new StationStatsDateError("Invalid station date.");
  const now = opts.now ?? Date.now();
  const archive = await readArchive(opts.dir ?? directory(), now);
  const response = summarizeStationStats(archive, now, opts.date);
  const failure = workerGlobal[WORKER_KEY]?.error;
  // A present-day collector failure is not an error in a historical day's data.
  if (failure && (response.isToday || opts.date === undefined)) {
    response.error = [response.error, failure].filter(Boolean).join(" ");
    response.activity.error = [response.activity.error, failure].filter(Boolean).join(" ");
  }
  return response;
}

type Config = { apiUrl: string };
export type CollectorOptions = {
  now?: () => number;
  fetch?: typeof fetch;
  loadConfig?: () => Promise<Config>;
  loadActivity?: (now: number, dir: string) => Promise<ActivitySnapshot>;
  dir?: string;
  /** Scheduling seam: production always requests a 60-second cadence. */
  schedule?: (tick: () => void, intervalMs: number) => () => void;
};
export type StationStatsCollector = {
  poll: () => Promise<void>;
  stop: () => Promise<void>;
  error: string | null;
};
const WORKER_KEY = Symbol.for("subwave.station-stats.collector");
const workerGlobal = globalThis as typeof globalThis & { [WORKER_KEY]?: StationStatsCollector };

async function defaultActivity(now: number, dir: string): Promise<ActivitySnapshot> {
  const { readStationActivity } = await import("./station-activity");
  return readStationActivity(now, dir);
}

async function defaultConfig(): Promise<Config> {
  const { getSubwaveConfig } = await import("./subwave");
  const { apiUrl } = await getSubwaveConfig();
  return { apiUrl };
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("Source timeout")); }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchObject(url: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  return withDeadline(async (signal) => {
    const res = await fetcher(url, { signal, cache: "no-store" });
    if (!res.ok) throw new Error("Source unavailable");
    const value: unknown = await res.json();
    if (!isObject(value)) throw new Error("Invalid source response");
    return value;
  });
}

export function startStationStatsCollector(opts: CollectorOptions = {}): StationStatsCollector | null {
  if (process.env.NEXT_PHASE === "phase-production-build") return null;
  if (workerGlobal[WORKER_KEY]) return workerGlobal[WORKER_KEY];
  const now = opts.now ?? Date.now;
  const dir = opts.dir ?? directory();
  const fetcher = opts.fetch ?? fetch;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let lastMinute: number | null = null;
  let config: Config | null = null;
  let configLoad: Promise<Config> | null = null;
  let configExpires = -Infinity;
  let metadata: { trackingSince: string; timeZone: string | null; activityTrackingSince: string | null } | null = null;
  let cancel = () => {};

  const collect = async () => {
    const at = now();
    const minute = Math.floor(at / SAMPLE_INTERVAL_MS);
    if (minute === lastMinute) return false;
    lastMinute = minute;
    const issues: Issue[] = [];
    // Observe app activity at the same timestamp, before archive/config/HTTP waits.
    // Failure stays in its own channel and must not discard valid station metrics.
    let activity: ActivitySnapshot | null;
    try { activity = decodeActivity(await (opts.loadActivity ?? defaultActivity)(at, dir)); }
    catch { activity = null; }
    if (!metadata) {
      const archive = await readArchive(dir, at);
      metadata = { trackingSince: archive.trackingSince || iso(at), timeZone: archive.timeZone,
        activityTrackingSince: archive.activityTrackingSince ?? null };
    }
    if (at >= configExpires) {
      // Cache failed loads too: an unreachable DB must not become a minute heartbeat.
      configExpires = at + CONFIG_CACHE_MS;
      try {
        // A stalled DB call is bounded for the collector, but never duplicated.
        configLoad ??= Promise.resolve().then(opts.loadConfig ?? defaultConfig)
          .then(({ apiUrl }) => ({ apiUrl })).finally(() => { configLoad = null; });
        config = await withDeadline(() => configLoad!);
      } catch { config = null; }
    }
    let np: Record<string, unknown> | null = null;
    let state: Record<string, unknown> | null = null;
    if (config?.apiUrl) {
      const base = config.apiUrl.replace(/\/+$/, "");
      const results = await Promise.allSettled([
        fetchObject(`${base}/now-playing`, fetcher), fetchObject(`${base}/state`, fetcher),
      ]);
      if (results[0].status === "fulfilled") np = results[0].value;
      else issues.push("now_playing_unavailable");
      if (results[1].status === "fulfilled") state = results[1].value;
      else issues.push("state_unavailable");
    } else issues.push("config_unavailable");
    const count = isObject(np?.listeners) ? np.listeners.current : null;
    const listeners = validCount(count) ? count : null;
    const onAir = state?.streamIdle === true || np?.streamOnline === false ? false
      : state?.streamIdle === false && np?.streamOnline === true ? true : null;
    if (np && listeners === null) issues.push("invalid_listeners");
    if ((np || state) && onAir === null) issues.push("invalid_air_state");
    metadata.timeZone = validStationTimeZone(np?.timezone) || validStationTimeZone(state?.timezone) || metadata.timeZone;
    const activityTrackingSince = activity ? earliest(metadata.activityTrackingSince, iso(at)) : metadata.activityTrackingSince;
    await persistStationObservation({ at: iso(at), listeners, onAir, issues, activity }, { ...metadata, activityTrackingSince }, dir);
    // Advance activity tracking only when evidence actually reached the archive.
    metadata.activityTrackingSince = activityTrackingSince;
    return true;
  };
  const worker: StationStatsCollector = {
    error: null,
    poll() {
      if (stopped) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = collect().then((persisted) => { if (persisted) worker.error = null; }).catch((error: unknown) => {
        worker.error = "Station observation could not be persisted.";
        const code = codeOf(error);
        console.warn("[station-stats] observation could not be persisted:",
          typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code) ? code : "invalid or unreadable statistics data");
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
    async stop() {
      stopped = true;
      cancel();
      await inFlight;
      if (workerGlobal[WORKER_KEY] === worker) delete workerGlobal[WORKER_KEY];
    },
  };
  workerGlobal[WORKER_KEY] = worker;
  try {
    const schedule = opts.schedule ?? ((tick: () => void, ms: number) => {
      const timer = setInterval(tick, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
    cancel = schedule(() => { void worker.poll(); }, SAMPLE_INTERVAL_MS);
    void worker.poll();
  } catch (e) {
    delete workerGlobal[WORKER_KEY];
    throw e;
  }
  return worker;
}
