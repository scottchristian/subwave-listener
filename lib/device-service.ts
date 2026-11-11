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
  DevicePresenter,
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
  // The byline resolves presenter bios from the schedule's personas, because
  // now-playing carries names and faces but no taglines. Fetch it alongside the
  // other feeds when there is a show on air, and hand the same copy to callers
  // that also need the runway or the shows window.
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
 * Normalizes a tagline: returns trimmed non-empty string or null.
 * Rejects non-string inputs, empty strings, and whitespace-only strings.
 */
function cleanTagline(val: unknown): string | null {
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Builds O(1) lookup indices for schedule personas by ID and name.
 * Safe against null, undefined, primitive, or cyclic elements in personas array.
 */
function indexSchedulePersonas(personas: unknown): {
  byId: Map<string, any>;
  byName: Map<string, any>;
} {
  const byId = new Map<string, any>();
  const byName = new Map<string, any>();
  if (Array.isArray(personas)) {
    for (const p of personas) {
      if (p && typeof p === "object") {
        if (typeof p.id === "string" && p.id && !byId.has(p.id)) {
          byId.set(p.id, p);
        }
        if (typeof p.name === "string" && p.name && !byName.has(p.name)) {
          byName.set(p.name, p);
        }
      }
    }
  }
  return { byId, byName };
}

function findPersona(
  index: { byId: Map<string, any>; byName: Map<string, any> },
  id?: string | null,
  name?: string | null,
): any | null {
  if (id && index.byId.has(id)) return index.byId.get(id);
  if (name && index.byName.has(name)) return index.byName.get(name);
  return null;
}

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
  const show = typeof nowPlaying?.activeShow?.name === "string" ? nowPlaying.activeShow.name : null;
  const presenter =
    typeof nowPlaying?.activeShow?.persona?.name === "string"
      ? nowPlaying.activeShow.persona.name
      : typeof nowPlaying?.dj?.name === "string"
        ? nowPlaying.dj.name
        : null;

  const presenterPersona =
    (nowPlaying?.activeShow?.persona && typeof nowPlaying.activeShow.persona === "object"
      ? nowPlaying.activeShow.persona
      : null) ||
    (nowPlaying?.dj && typeof nowPlaying.dj === "object" ? nowPlaying.dj : null);

  const personaIndex = indexSchedulePersonas(schedule?.personas);

  const presenterId = typeof presenterPersona?.id === "string" && presenterPersona.id ? presenterPersona.id : null;
  const matchedPersona = findPersona(personaIndex, presenterId, presenter);

  const effectivePresenterId = presenterId || (typeof matchedPersona?.id === "string" ? matchedPersona.id : null);
  const avatar = effectivePresenterId ? `/api/devices/avatar?id=${encodeURIComponent(effectivePresenterId)}` : null;
  const live = Boolean(nowPlaying) && !state?.streamIdle;

  const rawTagline = presenterPersona?.tagline ?? matchedPersona?.tagline;
  const tagline = cleanTagline(rawTagline);

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

  // Multi-host / presenter resolution:
  const presenters: DevicePresenter[] = [];
  if (live) {
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();

    // 1. Primary host (if active / on-air)
    const hostName =
      (typeof presenterPersona?.name === "string" && presenterPersona.name) ||
      presenter ||
      null;

    if (hostName) {
      if (effectivePresenterId) seenIds.add(effectivePresenterId);
      seenNames.add(hostName.toLowerCase());
      presenters.push({
        id: effectivePresenterId ?? "",
        name: hostName,
        role: "Host",
        tagline: tagline ?? null,
        avatar: avatar ?? null,
      });
    }

    // 2. Guests from activeShow.guests
    const rawGuests: any[] = Array.isArray(nowPlaying?.activeShow?.guests)
      ? nowPlaying.activeShow.guests
      : [];

    for (const g of rawGuests) {
      if (!g) continue;
      let gId =
        typeof g === "object" && typeof g.id === "string" && g.id
          ? g.id
          : typeof g === "string"
            ? g
            : null;
      let gName =
        typeof g === "object" && typeof g.name === "string" && g.name
          ? g.name
          : null;
      let gRole =
        typeof g === "object" && typeof g.role === "string" && g.role.trim()
          ? g.role.trim()
          : "Guest";

      const matchedGuest = findPersona(personaIndex, gId, gName);
      if (matchedGuest) {
        if (!gId && typeof matchedGuest.id === "string") gId = matchedGuest.id;
        if (!gName && typeof matchedGuest.name === "string") gName = matchedGuest.name;
      }

      if (!gName && !gId) continue;
      const finalName = gName || gId || "";
      const finalId = gId || "";

      if (finalId && seenIds.has(finalId)) continue;
      if (finalName && seenNames.has(finalName.toLowerCase())) continue;

      if (finalId) seenIds.add(finalId);
      if (finalName) seenNames.add(finalName.toLowerCase());

      const rawGTag =
        typeof g === "object" ? (g.tagline ?? matchedGuest?.tagline) : matchedGuest?.tagline;
      const gTagline = cleanTagline(rawGTag);
      const gAvatar = finalId
        ? `/api/devices/avatar?id=${encodeURIComponent(finalId)}`
        : null;

      presenters.push({
        id: finalId,
        name: finalName,
        role: gRole,
        tagline: gTagline,
        avatar: gAvatar,
      });
    }

    // 3. Guests from schedule.shows (if show matches and has guestPersonaIds)
    const activeShowId =
      typeof nowPlaying?.activeShow?.id === "string" ? nowPlaying.activeShow.id : null;
    // The schedule show is what carries the co-hosts. Match it three ways
    // because the now-playing feed does not always agree with the schedule:
    // an id when it has one, the name when it has that, and the host persona
    // when a show has been renamed since it was saved. Falling back only to
    // id/name dropped the second host of a renamed show entirely.
    const matchedShow = Array.isArray(schedule?.shows)
      ? schedule.shows.find(
          (s: any) =>
            (activeShowId && s?.id === activeShowId) ||
            (show && typeof s?.name === "string" && s.name === show) ||
            (effectivePresenterId && s?.personaId === effectivePresenterId),
        )
      : null;

    const showGuestIds: string[] = [
      ...(Array.isArray(nowPlaying?.activeShow?.guestPersonaIds)
        ? nowPlaying.activeShow.guestPersonaIds
        : []),
      ...(Array.isArray(matchedShow?.guestPersonaIds)
        ? matchedShow.guestPersonaIds
        : []),
    ];

    for (const gid of showGuestIds) {
      if (typeof gid !== "string" || !gid) continue;
      if (seenIds.has(gid)) continue;

      const gp = personaIndex.byId.get(gid);
      const gName = typeof gp?.name === "string" ? gp.name : gid;
      if (seenNames.has(gName.toLowerCase())) continue;

      seenIds.add(gid);
      seenNames.add(gName.toLowerCase());

      const gTagline = cleanTagline(gp?.tagline);
      const gAvatar = `/api/devices/avatar?id=${encodeURIComponent(gid)}`;

      presenters.push({
        id: gid,
        name: gName,
        role: typeof gp?.role === "string" && gp.role.trim() ? gp.role.trim() : "Guest",
        tagline: gTagline,
        avatar: gAvatar,
      });
    }
  }

  return {
    presenter,
    show,
    avatar,
    tagline,
    onAirForSec,
    endsInSec,
    live,
    presenters,
  };
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

  const shows = (data.shows as any[]) ?? [];
  const personas = (data.personas as any[]) ?? [];
  const personaById = new Map<string, any>();
  if (Array.isArray(personas)) {
    for (const p of personas) {
      if (p && typeof p === "object" && typeof p.id === "string") {
        personaById.set(p.id, p);
      }
    }
  }
  const showById = new Map<string, any>();
  if (Array.isArray(shows)) {
    for (const s of shows) {
      if (s && typeof s === "object" && typeof s.id === "string") {
        showById.set(s.id, s);
      }
    }
  }

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

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const fmtHour = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;

  const allSlots: DeviceSlot[] = [];

  // Inspect up to 3 consecutive days so the device has a rolling window across midnight into tomorrow.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const d = (nowDay + dayOffset) % 7;
    const dayName = dayNames[d];
    const row: (string | null)[] = Array.isArray(grid[String(d)]) ? grid[String(d)] : [];

    // Consecutive hours running the same show are one slot, not N.
    const dayRawSlots: { showId: string | null; from: number; to: number }[] = [];
    for (let h = 0; h < 24; h++) {
      const id = h < row.length ? row[h] || null : null;
      const last = dayRawSlots[dayRawSlots.length - 1];
      if (last && last.showId === id) last.to = h + 1;
      else dayRawSlots.push({ showId: id, from: h, to: h + 1 });
    }

    for (const slot of dayRawSlots) {
      const live = dayOffset === 0 && nowHour >= slot.from && nowHour < slot.to;
      const show = slot.showId ? showById.get(slot.showId) : null;
      if (!show) {
        // An empty slot is the station running itself. The web player calls this
        // Auto DJ and gives it the station logo as its avatar; the screen does the
        // same, by simply sending no avatar so it renders the logo itself.
        allSlots.push({
          from: fmtHour(slot.from),
          to: fmtHour(slot.to),
          live,
          day: dayName,
          dayOffset,
          show: { id: null, name: "Auto DJ", presenters: [] },
        });
      } else {
        const host = typeof show.personaId === "string" ? personaById.get(show.personaId) : null;
        const rawTagline = host?.tagline;
        const tagline = cleanTagline(rawTagline);
        const hostId = typeof host?.id === "string" ? host.id : undefined;
        const hostName = typeof host?.name === "string" ? host.name : undefined;
        const hostAvatar = hostId ? `/api/devices/avatar?id=${encodeURIComponent(hostId)}` : undefined;

        const seenIds = new Set<string>();
        if (hostId) seenIds.add(hostId);
        if (typeof show.personaId === "string" && show.personaId) seenIds.add(show.personaId);

        const guestIds: string[] = Array.isArray(show.guestPersonaIds) ? show.guestPersonaIds : [];
        const guests: {
          id: string;
          name: string;
          role: string;
          tagline: string | null;
          avatar: string | null;
        }[] = [];

        for (const gid of guestIds) {
          if (typeof gid !== "string" || !gid) continue;
          if (seenIds.has(gid)) continue;

          const p = personaById.get(gid);
          if (!p || typeof p !== "object") continue;

          const guestId = typeof p.id === "string" && p.id ? p.id : gid;
          if (seenIds.has(guestId)) continue;

          seenIds.add(gid);
          seenIds.add(guestId);

          const rawGTag = p.tagline;
          const guestTagline = cleanTagline(rawGTag);
          const guestAvatar = guestId ? `/api/devices/avatar?id=${encodeURIComponent(guestId)}` : null;

          guests.push({
            id: guestId,
            name: typeof p.name === "string" ? p.name : "",
            role: typeof p.role === "string" && p.role.trim() ? p.role.trim() : "Guest",
            tagline: guestTagline,
            avatar: guestAvatar,
          });
        }

        const presenters: DevicePresenter[] = [];
        if (hostName) {
          presenters.push({
            id: hostId ?? "",
            name: hostName,
            role: "Host",
            tagline: tagline ?? null,
            avatar: hostAvatar ?? null,
          });
        }
        for (const g of guests) {
          presenters.push({
            id: g.id,
            name: g.name,
            role: g.role || "Guest",
            tagline: g.tagline ?? null,
            avatar: g.avatar ?? null,
          });
        }

        allSlots.push({
          from: fmtHour(slot.from),
          to: fmtHour(slot.to),
          live,
          day: dayName,
          dayOffset,
          show: {
            id: show.id,
            name: show.name,
            host: hostName,
            hostId,
            tagline,
            avatar: hostAvatar,
            guests,
            presenters,
          },
        });
      }
    }
  }

  let liveIdx = allSlots.findIndex((s) => s.live);
  if (liveIdx === -1) liveIdx = 0;

  // Take up to 10 slots from the live slot forward.
  const slots: DeviceSlot[] = allSlots.slice(liveIdx, liveIdx + 10);

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
  const { nowPlaying, state, schedule } = await fetchBackendFeeds();

  const np = nowPlaying?.nowPlaying;
  const counts = {
    signedIn: await countSignedIn(),
    listening: typeof nowPlaying?.listeners?.current === "number" ? nowPlaying.listeners.current : null,
  };

  // The listener-facing now-playing feed strips persona taglines, so the bio
  // only exists on /schedule. Use the copy the feeds already fetched: a second
  // fetch per poll could fail or time out on its own and leave the screen
  // saying "No bio provided" for a presenter who has one.
  const byline = buildByline(nowPlaying, state, schedule);
  const theme = resolveTheme(row, atMs);

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
      // 0 = never, and absent means the same for a row created before the
      // column existed. The screen treats "never" as "dim and stay dim".
      offMin: row.idleOffMin ?? 0,
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
    idleOffMin: row.idleOffMin ?? 0,
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
  if (typeof patch.idleOffMin === "number" && Number.isFinite(patch.idleOffMin)) {
    // Zero is a real value ("never"), not the bottom of the range: clamping it
    // to 1 would make Never impossible to choose from any client.
    next.idleOffMin = Math.max(0, Math.min(240, Math.round(patch.idleOffMin)));
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
      idleOffMin: next.idleOffMin,
      // Stored as "1"/"0", not a boolean, because this schema has to generate
      // for SQLite as well as Postgres and the other flags are strings too.
      skipEnabled: next.skipEnabled ? "1" : "0",
      settingsRev: row.settingsRev + 1,
    },
  });

  return { settings: deviceSettingsOf(updated), changed: true, settingsRev: updated.settingsRev };
}