// station-schedule.ts — the weekly grid and its shows, read from the station
// host that serves the listener-facing /api/schedule.
//
// Server-only. The reminder scheduler runs with no request in hand, so it
// cannot borrow the browser's fetch of this data; it asks the host itself.
// Failure is never fatal: no schedule simply means no reminders this tick.

import { STATION } from "./station";
import { dialCodeForTimezone } from "./phone";

export interface ScheduleShow {
  id: string;
  name?: string | null;
}

export interface StationSchedule {
  /** 7x24 grid keyed by JS weekday string ("0" = Sunday). */
  grid: Record<string, (string | null)[]>;
  shows: ScheduleShow[];
  timezone: string;
}

export async function fetchStationSchedule(fetchImpl: typeof fetch = fetch): Promise<StationSchedule | null> {
  const base = STATION.backendUrl;
  if (!base) return null;
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/schedule`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const timezone = typeof data?.timezone === "string" ? data.timezone : "";
    const grid = data?.schedule;
    if (!timezone || !grid || typeof grid !== "object") return null;
    const shows = Array.isArray(data?.shows)
      ? data.shows.filter((s: any) => s && typeof s.id === "string")
      : [];
    return { grid, shows, timezone };
  } catch {
    return null;
  }
}

let dialCache: { value: string; at: number } | null = null;
const DIAL_TTL_MS = 10 * 60 * 1000;

/**
 * The country code a locally typed number is completed with: the station's
 * own dial code, from its schedule timezone. Cached, because the account
 * menu's status read should not chase the schedule host on every open. A
 * failed lookup falls back to the operator override and is not cached, so a
 * brief outage does not pin an empty answer.
 */
export async function stationDialCode(fetchImpl?: typeof fetch): Promise<string> {
  if (dialCache && Date.now() - dialCache.at < DIAL_TTL_MS) return dialCache.value;
  const schedule = await fetchStationSchedule(fetchImpl);
  const value =
    dialCodeForTimezone(schedule?.timezone) || String(process.env.LINQ_DEFAULT_COUNTRY || "").trim();
  if (value) dialCache = { value, at: Date.now() };
  return value;
}
