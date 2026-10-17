import prisma from "@/lib/prisma";
import { getSubwaveConfig } from "@/lib/subwave";
import { computeShowRunway } from "@/lib/show-runway";
import { runForDay } from "@/lib/schedule-run";
import {
  canSkipAsScreen,
  parseSkipVisibility,
  parseSkipVisibilityScreens,
  SKIP_VISIBILITY_SCREENS_DEFAULT,
} from "@/lib/skipvisibility";
import { solarWindow, isNightAt } from "@/lib/solar";
import type {
  DeviceSchedule,
  DeviceSettings,
  DeviceSlot,
  DeviceState,
  IdleMode,
  Orientation,
  SkipLabel,
  ThemeMode,
} from "@/lib/device-types";
import type { Device } from "@prisma/client";

/**
 * Everything a screen is told, assembled in one place.
 *
 * WHY A SERVICE LAYER AND NOT ROUTE LOGIC. A wall display runs unattended and
 * nobody is watching it fail, so the cost of a subtle mistake here is not an
 * error message — it is a screen that quietly shows the wrong thing for months.
 * Two properties follow:
 *
 *   ONE SOURCE OF TRUTH PER VALUE. The listener count, the Skip button state, the
 *   show runway: each is computed exactly once, here, and both the player and the
 *   device route read the same answer. If the wall and the browser can disagree,
 *   one of them is lying and nobody can tell which.
 *
 *   THE DEVICE NEVER DECIDES ANYTHING. It receives `skip.label` as a finished
 *   string, not a mode plus a listener count to interpret. Policy lives here in
 *   TypeScript where it can be asserted; firmware renders.
 *
 * NOTHING IN HERE MAY TOUCH PRESENCE. A device must never appear in the signed-in
 * count. It READS that count — a wall display showing a wrong number would be
 * embarrassing — but there is no write path anywhere under app/api/devices.
 * check-device-isolation.mts enforces the absence, and this file is on its list.
 */

const BACKEND_TIMEOUT_MS = 15_000;

/** Day brightness is capped BELOW night brightness, deliberately. See design.md. */
export const DAY_BRIGHTNESS_CAP = 70;
export const NIGHT_BRIGHTNESS_CAP = 100;

/** Daylight runs on a widened window: rooms are still bright at the horizon. */
export const TWILIGHT_MINUTES = 30;

export const DEFAULT_POLL_SEC = 10;

// ---------------------------------------------------------------------------
// Station settings
// ---------------------------------------------------------------------------

/** One read for every device setting, rather than one query per screen. */
export async function getSkipSettings(): Promise<{
  listeners: import("@/lib/skipvisibility").SkipVisibility;
  screens: import("@/lib/skipvisibility").SkipVisibilityScreens;
}> {
  let listeners: string | null = null;
  let screens: string | null = null;
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["skipVisibility", "skipVisibilityScreens"] } },
      select: { key: true, value: true },
    });
    listeners = rows.find((r) => r.key === "skipVisibility")?.value ?? null;
    screens = rows.find((r) => r.key === "skipVisibilityScreens")?.value ?? null;
  } catch {
    // A read failure must NOT fail open. Parsing null gives solo/follow, which
    // land on canSkipAsListener — the most restrictive live behaviour.
  }
  return {
    listeners: parseSkipVisibility(listeners),
    screens: parseSkipVisibilityScreens(screens ?? SKIP_VISIBILITY_SCREENS_DEFAULT),
  };
}

/** Station coordinates, captured during setup or set in the admin panel. */
export async function getStationLocation(): Promise<{ lat: number; lon: number } | null> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["stationLat", "stationLon"] } },
      select: { key: true, value: true },
    });
    const lat = Number(rows.find((r) => r.key === "stationLat")?.value);
    const lon = Number(rows.find((r) => r.key === "stationLon")?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat === 0 && lon === 0) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

type BackendFeeds = {
  nowPlaying: any | null;
  state: any | null;
  schedule: any | null;
};

/**
 * All three backend feeds at once, failing soft.
 *
 * Every fetch is independent and every one of them may come back null: the
 * station being mid-restart, an upstream timeout, a shape change. A screen that
 * renders "nothing right now" is a far better outcome than a screen that
 * white-screens because one of three requests threw. So this never rejects —
 * it resolves with whatever arrived, and the caller decides what an incomplete
 * set means.
 */
export async function fetchBackendFeeds(): Promise<BackendFeeds> {
  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) return { nowPlaying: null, state: null, schedule: null };

  const get = async (path: string): Promise<any | null> => {
    try {
      const res = await fetch(`${cfg.apiUrl}${path}`, {
        signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  const [nowPlaying, state] = await Promise.all([
    get("/now-playing"),
    get("/state"),
  ]);
  // Schedule is only needed for the shows window and the runway, and it is
  // large, so it is fetched lazily rather than on every 10-second poll.
  let schedule: any | null = null;
  if (nowPlaying) {
    schedule = await get("/schedule");
  }
  return { nowPlaying, state, schedule };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Resolve the device's theme, brightness, and the next moment it changes.
 *
 * `auto` follows the sun; `day` and `night` are pinned, because some rooms want
 * a permanently dark screen and should be able to say so rather than fight the
 * astronomy.
 *
 * Without coordinates the device falls back to night rendering permanently.
 * That is the safe direction: a screen that is too dim is obvious and fixable
 * from the app; a 1000-nit panel at 3am in someone's bedroom is neither.
 */
export function resolveTheme(
  row: Pick<Device, "themeMode" | "brightness" | "lat" | "lon">,
  atMs: number,
): DeviceState["theme"] {
  const mode = (row.themeMode as ThemeMode) || "auto";
  const hasCoords = typeof row.lat === "number" && typeof row.lon === "number";
  const spot = hasCoords ? { lat: row.lat!, lon: row.lon!, atMs } : null;

  let isNight = true;
  let sunriseMs = 0;
  let sunsetMs = 0;

  if (spot) {
    try {
      const win = solarWindow(spot, TWILIGHT_MINUTES);
      if (win.sunriseMs !== null && win.sunsetMs !== null) {
        sunriseMs = win.sunriseMs;
        sunsetMs = win.sunsetMs;
        isNight = isNightAt(spot, atMs);
      }
    } catch {
      // Bad coordinates must not take the screen down; fall through to night.
      isNight = true;
    }
  }

  const resolved: "day" | "night" = mode === "day" ? "day" : mode === "night" ? "night" : isNight ? "night" : "day";
  const cap = resolved === "day" ? DAY_BRIGHTNESS_CAP : NIGHT_BRIGHTNESS_CAP;
  const requested = typeof row.brightness === "number" ? row.brightness : 70;

  return {
    mode: resolved,
    isNight: resolved === "night",
    sunriseMs,
    sunsetMs,
    brightness: Math.max(1, Math.min(requested, cap)),
  };
}

// ---------------------------------------------------------------------------
// Skip
// ---------------------------------------------------------------------------

const WORDS = ["no one", "one person", "two people", "three people", "four people", "several people"];

function listenerPhrase(n: number | null): string {
  if (n === null) return "somebody";
  if (n <= 0) return "nobody else";
  return WORDS[n] ?? "several people";
}

/**
 * The entire Skip button, decided here.
 *
 * The device receives a finished label, not a mode to interpret. That is the
 * point of the whole exercise: the same canSkipAsListener the player reads
 * decides this, so a button shown on the wall can never be one the server would
 * refuse — which is the dead control lib/skipvisibility.ts exists to prevent.
 */
export function buildSkipState(
  settings: { listeners: import("@/lib/skipvisibility").SkipVisibility; screens: import("@/lib/skipvisibility").SkipVisibilityScreens },
  row: Pick<Device, "skipEnabled">,
  counts: { listening: number | null; cooldownSec: number; locked: boolean },
): DeviceState["skip"] {
  const deviceEnabled = row.skipEnabled !== "0";
  const shown = canSkipAsScreen(settings.screens, settings.listeners, counts.listening, deviceEnabled);

  let label: SkipLabel = "Skip track";
  let reason: string | null = null;

  if (!shown) {
    if (!deviceEnabled) reason = "Skip is turned off for this screen";
    else if (settings.screens === "hidden") reason = "Skip is turned off for screens";
    else if (settings.listeners === "hidden") reason = "Skip is turned off for listeners";
    else if ((counts.listening ?? 0) > 1) reason = `${listenerPhrase(counts.listening)} are listening`;
    else reason = "Skip is not available right now";
  } else if (counts.locked) {
    label = "Next song incoming";
  } else if (counts.cooldownSec > 0) {
    label = `Skip in ${counts.cooldownSec}s`;
  }

  return {
    shown,
    enabled: shown && !counts.locked && counts.cooldownSec <= 0,
    label,
    cooldownSec: Math.max(0, counts.cooldownSec),
    locked: counts.locked,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Byline and runway
// ---------------------------------------------------------------------------

/**
 * Who is on air, and for how much longer.
 *
 * The presenter precedence is the player's (app/page.tsx:2290): the show's own
 * persona if a show owns the air, otherwise whoever the station currently has
 * on. The runway is NOT in now-playing — there is no handover timestamp there at
 * all, so it comes from the schedule feed through the same computeShowRunway the
 * player uses, which is what makes the wall and the browser agree.
 */
export function buildByline(
  nowPlaying: any | null,
  state: any | null,
  schedule: any | null,
): DeviceState["byline"] {
  const show = nowPlaying?.activeShow?.name ?? null;
  const presenter = nowPlaying?.activeShow?.persona?.name || nowPlaying?.dj?.name || null;
  const live = Boolean(nowPlaying) && !state?.streamIdle;

  let onAirForSec: number | null = null;
  const startedAt = state?.session?.startedAt;
  if (typeof startedAt === "string") {
    const t = Date.parse(startedAt);
    if (Number.isFinite(t)) onAirForSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  }

  let endsInSec: number | null = null;
  if (schedule?.timezone) {
    try {
      const runway = computeShowRunway({
        grid: schedule.schedule,
        shows: schedule.shows,
        personas: schedule.personas,
        timezone: schedule.timezone,
        override: schedule.override,
        now: Date.now(),
      });
      if (runway?.endMs) {
        endsInSec = Math.max(0, Math.round((runway.endMs - Date.now()) / 1000));
      }
    } catch {
      // No runway is fine. A show with no announced end just shows no countdown.
    }
  }

  return { presenter, show, onAirForSec, endsInSec, live };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * "Now and next", merged server-side.
 *
 * The device never does date maths. Consecutive identical days are collapsed
 * with the same runForDay the player uses, consecutive same-show hours are
 * collapsed into slots, and every time is already formatted in station time.
 * A firmware implementation of any of that would be a second place to be wrong.
 */
export async function buildDeviceSchedule(atMs: number = Date.now()): Promise<DeviceSchedule> {
  const cfg = await getSubwaveConfig();
  const empty: DeviceSchedule = { timezone: "UTC", dayLabel: "", slots: [] };
  if (!cfg.apiUrl) return empty;

  let data: any;
  try {
    const res = await fetch(`${cfg.apiUrl}/schedule`, {
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return empty;
    data = await res.json();
  } catch {
    return empty;
  }

  const tz = typeof data?.timezone === "string" ? data.timezone : "UTC";
  const grid = data?.schedule;
  if (!grid || !Array.isArray(data?.shows)) return { ...empty, timezone: tz };

  const shows = data.shows as any[];
  const personas = (data.personas as any[]) ?? [];
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const showById = new Map(shows.map((s) => [s.id, s]));

  // Which day is it, in station time? Ask in the station's own zone, never the
  // server's, or a morning show reads as yesterday's.
  let nowDay = 0;
  let nowHour = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: tz, weekday: "short", hour: "numeric", hour12: false,
    }).formatToParts(new Date(atMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    nowDay = Math.max(0, days.indexOf(get("weekday")));
    nowHour = parseInt(get("hour"), 10) % 24;
  } catch {
    return { ...empty, timezone: tz };
  }

  // Collapse identical consecutive days into one run, exactly as the player does,
  // so a station running one lineup shows one day rather than seven copies.
  let sig = (d: number) => {
    const row = grid[String(((d % 7) + 7) % 7)];
    return Array.isArray(row) ? row.map((id) => id || "-").join(",") : "";
  };
  const { start } = runForDay(sig, nowDay);
  const row: (string | null)[] = Array.isArray(grid[String(((start % 7) + 7) % 7)]) ? grid[String(((start % 7) + 7) % 7)] : [];

  // Consecutive hours running the same show are one slot, not N.
  const rawSlots: { showId: string | null; from: number; to: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const id = h < row.length ? row[h] || null : null;
    const last = rawSlots[rawSlots.length - 1];
    if (last && last.showId === id) last.to = h + 1;
    else rawSlots.push({ showId: id, from: h, to: h + 1 });
  }

  const fmtHour = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;

  const slots: DeviceSlot[] = rawSlots.map((slot) => {
    const show = slot.showId ? showById.get(slot.showId) : null;
    const live = nowHour >= slot.from && nowHour < slot.to;
    if (!show) {
      // An empty slot is the station running itself. The web player calls this
      // Auto DJ and gives it the station logo as its avatar; the screen does the
      // same, by simply sending no avatar so it renders the logo itself.
      return { from: fmtHour(slot.from), to: fmtHour(slot.to), live, show: { id: null, name: "Auto DJ" } };
    }
    const host = show.personaId ? personaById.get(show.personaId) : null;
    const guests = (show.guestPersonaIds as string[] | undefined)
      ?.map((id) => personaById.get(id))
      .filter((p): p is any => Boolean(p))
      .map((p) => ({ id: p.id, name: p.name })) ?? [];
    return {
      from: fmtHour(slot.from),
      to: fmtHour(slot.to),
      live,
      show: {
        id: show.id,
        name: show.name,
        host: host?.name,
        hostId: host?.id,
        guests,
      },
    };
  });

  let dayLabel = "";
  try {
    dayLabel = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long" }).format(new Date(atMs));
  } catch {}

  return { timezone: tz, dayLabel, slots };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The whole /state payload.
 *
 * Signs are read, never written. `signedIn` comes from the same presence map the
 * player reads; nothing here can add to it, and that is enforced by
 * check-device-isolation.mts rather than by good intentions.
 */
export async function buildDeviceState(row: Device, atMs: number = Date.now()): Promise<DeviceState> {
  const { nowPlaying, state } = await fetchBackendFeeds();

  const np = nowPlaying?.nowPlaying;
  const counts = {
    signedIn: await countSignedIn(),
    listening: typeof nowPlaying?.listeners?.current === "number" ? nowPlaying.listeners.current : null,
  };

  let byline = buildByline(nowPlaying, state, null);
  let theme = resolveTheme(row, atMs);

  // The runway needs the schedule feed, which is large. Only pay for it when the
  // device is actually going to show a countdown.
  if (byline.live) {
    const cfg = await getSubwaveConfig();
    if (cfg.apiUrl) {
      try {
        const res = await fetch(`${cfg.apiUrl}/schedule`, { signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS), cache: "no-store" });
        if (res.ok) byline = buildByline(nowPlaying, state, await res.json());
      } catch {}
    }
  }

  const skipSettings = await getSkipSettings();
  const skip = buildSkipState(skipSettings, row, {
    listening: counts.listening,
    cooldownSec: 0,
    locked: false,
  });

  const stationName = state?.station?.name || nowPlaying?.dj?.station || "This station";

  return {
    serverNowMs: atMs,
    pollAfterSec: DEFAULT_POLL_SEC,
    station: { name: stationName, logo: "/brand/logo.png" },
    now: {
      subsonicId: np?.subsonic_id ?? "",
      title: np?.title ?? "",
      artist: np?.artist ?? "",
      album: np?.album ?? undefined,
      art: np?.subsonic_id ? `/api/devices/art?id=${encodeURIComponent(np.subsonic_id)}` : "",
      startedAtMs: toEpochMs(state?.current?.startedAt) ?? toEpochMs(np?.timestamp) ?? atMs,
      durationSec: typeof np?.duration === "number" ? np.duration : null,
      live: Boolean(np) && !state?.streamIdle,
    },
    byline,
    counts: { signedIn: counts.signedIn, listening: counts.listening ?? 0 },
    streamIdle: Boolean(state?.streamIdle),
    theme,
    idle: {
      mode: (row.idleMode as IdleMode) || "dim",
      min: row.idleMin ?? 15,
      pct: row.idlePct ?? 20,
    },
    skip,
    settingsRev: row.settingsRev,
  };
}

/** ISO 8601 or an epoch seconds number, to epoch ms. Never throws. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // The now-playing feed sends seconds; anything already in milliseconds is
    // far larger than any plausible epoch-seconds value.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  return null;
}

/**
 * How many listeners are signed in, read from the same live map the player
 * reads. READ ONLY.
 *
 * A device must never appear in this number, and cannot: nothing in this module
 * imports a notifier, and the presence map is populated from exactly one place
 * behind a session cookie.
 */
async function countSignedIn(): Promise<number> {
  try {
    const { freshPresence } = await import("@/lib/presence-live");
    return freshPresence(Date.now()).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function deviceSettingsOf(row: Device): DeviceSettings {
  return {
    brightness: row.brightness ?? 70,
    orientation: (row.orientation as Orientation) || "landscape",
    themeMode: (row.themeMode as ThemeMode) || "auto",
    idleMode: (row.idleMode as IdleMode) || "dim",
    idleMin: row.idleMin ?? 15,
    idlePct: row.idlePct ?? 20,
    skipEnabled: row.skipEnabled !== "0",
  };
}

/**
 * Apply an incoming settings change, bumping settingsRev only if something
 * actually changed.
 *
 * Bumping unconditionally would make the device and the admin flap: the device
 * applies, reports appliedRev, the server sees a higher number, nudges again,
 * forever. Comparing first is what makes the revision number mean something.
 */
export async function applyDeviceSettings(
  row: Device,
  patch: Partial<DeviceSettings>,
): Promise<{ settings: DeviceSettings; changed: boolean; settingsRev: number }> {
  const current = deviceSettingsOf(row);
  const next: DeviceSettings = { ...current };

  if (typeof patch.brightness === "number" && Number.isFinite(patch.brightness)) {
    next.brightness = Math.max(1, Math.min(100, Math.round(patch.brightness)));
  }
  if (patch.orientation === "landscape" || patch.orientation === "portrait") {
    next.orientation = patch.orientation;
  }
  if (patch.themeMode === "auto" || patch.themeMode === "day" || patch.themeMode === "night") {
    next.themeMode = patch.themeMode;
  }
  if (patch.idleMode === "stay" || patch.idleMode === "dim" || patch.idleMode === "off") {
    next.idleMode = patch.idleMode;
  }
  if (typeof patch.idleMin === "number" && Number.isFinite(patch.idleMin)) {
    next.idleMin = Math.max(1, Math.min(240, Math.round(patch.idleMin)));
  }
  if (typeof patch.idlePct === "number" && Number.isFinite(patch.idlePct)) {
    next.idlePct = Math.max(1, Math.min(100, Math.round(patch.idlePct)));
  }
  if (typeof patch.skipEnabled === "boolean") {
    next.skipEnabled = patch.skipEnabled;
  }

  const changed = (Object.keys(next) as (keyof DeviceSettings)[]).some((k) => next[k] !== current[k]);
  if (!changed) return { settings: current, changed: false, settingsRev: row.settingsRev };

  const updated = await prisma.device.update({
    where: { id: row.id },
    data: {
      brightness: next.brightness,
      orientation: next.orientation,
      themeMode: next.themeMode,
      idleMode: next.idleMode,
      idleMin: next.idleMin,
      idlePct: next.idlePct,
      // Stored as "1"/"0", not a boolean, because this schema has to generate
      // for SQLite as well as Postgres and the other flags are strings too.
      skipEnabled: next.skipEnabled ? "1" : "0",
      settingsRev: row.settingsRev + 1,
    },
  });

  return { settings: deviceSettingsOf(updated), changed: true, settingsRev: updated.settingsRev };
}