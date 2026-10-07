/**
 * "On air until …, and next: …" for the On The Air card.
 *
 * The weekly grid is the default answer, but an operator can pin a different
 * show to the air for a bounded window (the station's timed takeover). The
 * station resolves who is actually on air with that same precedence — takeover
 * first, grid second — so a card that only ever read the grid used to describe
 * the show the takeover had just replaced: the name in the header came from
 * /now-playing and had already moved on, while the until/next lines underneath
 * went on counting the replaced show's hour. Both have to answer from one
 * precedence or the card contradicts itself in front of a listener.
 *
 * PURE: no fetch, and no clock of its own — the caller passes `now`, so the
 * whole precedence (including every boundary minute) is testable.
 */

/** A show as the listener-facing `/api/schedule` lists it. */
export interface RunwayShow {
  id: string;
  name?: string | null;
  personaId?: string | null;
}

/** A persona as the listener-facing `/api/schedule` lists it. */
export interface RunwayPersona {
  id: string;
  name?: string | null;
  avatar?: string | null;
  /** Carried here too, so the "next host" card is as complete as the on-air one. */
  tagline?: string | null;
}

/**
 * A live takeover. `showId: null` is an explicit "Default programming" pin and
 * is NOT the same as no override at all: it still ends at `expiresAt`.
 */
export interface RunwayOverride {
  showId: string | null;
  startedAt: number;
  expiresAt: number;
}

export interface RunwayInput {
  /** 7x24 station-zone grid, keyed by JS weekday string ("0" = Sunday). */
  grid: Record<string, unknown> | null | undefined;
  shows: RunwayShow[] | null | undefined;
  personas: RunwayPersona[] | null | undefined;
  /** Station timezone. The grid is painted in it, not the browser's. */
  timezone: string | null | undefined;
  /** The station reports null for absent, expired AND dangling overrides. */
  override?: RunwayOverride | null;
  now: number;
}

/**
 * - `grid`               — nobody has taken over; the timetable decides.
 * - `takeover`           — a named show is pinned; `nextName` is what RESUMES.
 * - `default-takeover`   — "Default programming" pinned; the grid still decides
 *                          who follows, but the window still ends at `expiresAt`.
 */
export type RunwayMode = "grid" | "takeover" | "default-takeover";

export interface ShowRunway {
  mode: RunwayMode;
  endMs: number;
  leftMin: number;
  nextName: string | null;
  nextHost: string | null;
  nextPersona: RunwayPersona | null;
  /**
   * True when `nextName` is the show programming RETURNS to when the pin lapses,
   * rather than the show that follows it. The card words those differently, and
   * calling a resumption "Next" is what made the takeover look ignored.
   */
  nextIsResume: boolean;
  timezone: string;
}

/** Long enough for any real slot; also the guard against an all-week show. */
const MAX_SCAN_HOURS = 72;
const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Station wall-clock day/hour/minute. `hour % 24` absorbs the "24" some locales emit for midnight. */
function stationParts(timezone: string, now: number): { day: number; hour: number; minute: number } | null {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(now))) {
    parts[p.type] = p.value;
  }
  const day = DAY_KEYS.indexOf(parts.weekday);
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10) % 60;
  if (day < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { day, hour, minute };
}

export function computeShowRunway(input: RunwayInput): ShowRunway | null {
  const { grid, shows, personas, timezone, override, now } = input;
  if (!grid || !shows || !timezone) return null;
  const tz = timezone;

  try {
    const parts = stationParts(tz, now);
    if (!parts) return null;
    const { day, hour, minute } = parts;

    const showById = (id: string | null | undefined) => (id ? shows.find((s) => s.id === id) || null : null);
    const personaById = (id: string | null | undefined) => (id ? personas?.find((p) => p.id === id) || null : null);
    const idAt = (d: number, h: number): string | null => {
      const row = grid[String(((d % 7) + 7) % 7)];
      if (!Array.isArray(row)) return null;
      return (row as (string | null)[])[((h % 24) + 24) % 24] ?? null;
    };
    const nowMin = day * 24 * 60 + hour * 60 + minute;

    // Walk the timetable forward from the current slot to the hour mark where a
    // different show takes over. Grid mode only.
    const walkAhead = (fromDay: number, fromHour: number) => {
      const curId = idAt(fromDay, fromHour);
      if (!curId) return null;
      let d = fromDay;
      let h = fromHour;
      let guard = 0;
      do {
        h++;
        if (h >= 24) {
          h = 0;
          d++;
        }
        guard++;
      } while (guard < MAX_SCAN_HOURS && idAt(d, h) === curId);
      if (guard >= MAX_SCAN_HOURS) return null;
      const leftMin = Math.max((d * 24 + h) * 60 - nowMin, 1);
      return { next: showById(idAt(d, h)), leftMin, endMs: now + leftMin * 60000 };
    };

    // A pin that is between its start and end instants is in force. The station
    // reports null for absent, expired and dangling overrides alike, so
    // `showId: null` here can only ever mean "Default programming".
    const live =
      override && Number.isFinite(now) && now >= Number(override.startedAt) && now < Number(override.expiresAt)
        ? override
        : null;

    if (live) {
      const endMs = Number(live.expiresAt);
      const leftMin = Math.max(Math.round((endMs - now) / 60000), 1);
      const pinned = live.showId ? showById(live.showId) : null;

      // A named pin that names nothing real is void (a show deleted mid-pin) and
      // falls back to the timetable — which is what the station does too.
      if (live.showId && !pinned) {
        const walk = walkAhead(day, hour);
        if (!walk) return null;
        const persona = personaById(walk.next?.personaId);
        return {
          mode: "grid",
          endMs: walk.endMs,
          leftMin: walk.leftMin,
          nextName: walk.next?.name || null,
          nextHost: persona?.name || null,
          nextPersona: persona || null,
          nextIsResume: false,
          timezone: tz,
        };
      }

      if (pinned) {
        // What programming returns to when the pin lapses is the timetable's
        // own slot right now — the show the operator interrupted.
        const resume = showById(idAt(day, hour));
        const persona = personaById(resume?.personaId);
        return {
          mode: "takeover",
          endMs,
          leftMin,
          nextName: resume?.name || null,
          nextHost: persona?.name || null,
          nextPersona: persona || null,
          nextIsResume: true,
          timezone: tz,
        };
      }

      // Default programming pinned: the grid is what is on air, so "next" is the
      // ordinary walk ahead — but the window still closes at expiresAt.
      const walk = walkAhead(day, hour);
      const persona = personaById(walk?.next?.personaId);
      return {
        mode: "default-takeover",
        endMs,
        leftMin,
        nextName: walk?.next?.name || null,
        nextHost: persona?.name || null,
        nextPersona: persona || null,
        nextIsResume: false,
        timezone: tz,
      };
    }

    const walk = walkAhead(day, hour);
    if (!walk) return null;
    const persona = personaById(walk.next?.personaId);
    return {
      mode: "grid",
      endMs: walk.endMs,
      leftMin: walk.leftMin,
      nextName: walk.next?.name || null,
      nextHost: persona?.name || null,
      nextPersona: persona || null,
      nextIsResume: false,
      timezone: tz,
    };
  } catch {
    // A malformed grid or an unknown zone must not take the player down; the
    // card simply says nothing about a runway.
    return null;
  }
}
