/**
 * Time-window math and clock-face formatting for the automatic-update feature.
 *
 * CLIENT-SAFE BY CONSTRUCTION: this module imports nothing — no prisma, no
 * next-auth, no node builtins beyond Intl/Date. The admin panel and TimeSelect
 * are client components, and anything they import ships to the browser; a
 * single server import here (as happened once) breaks the production build
 * with unresolvable node builtins. Keep it that way: pure functions only.
 */

/**
 * Display helpers for the update-window picker. The stored value is always
 * "HH:MM" 24-hour; these only translate for eyes and fingers. Pure, so the
 * picker and the tests agree on what "10:30 PM" means.
 */
export function parseTimeOfDay(raw: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}


/** Exported for decideAutoTick; everyone else should use isInWindow. */
export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Minutes since midnight in the given IANA zone. Intl is the whole timezone
 * database here — no dependency for something the runtime already knows.
 */
export function minutesInZone(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 60 + m;
  } catch {
    return null; // unknown zone — caller falls back, never crashes the tick
  }
}

/** Is minute-of-day `now` inside [start, end)? Wraps past midnight. */
export function isInWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false; // zero-length window updates never
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export function splitTimeOfDay(t: string): { h24: number; m: number } | null {
  const v = parseTimeOfDay(t);
  if (!v) return null;
  const [h, m] = v.split(":").map(Number);
  return { h24: h, m };
}

/** "22:30" -> "10:30 PM" (or "22:30" in 24-hour mode). Never throws. */
export function formatTimeOfDay(t: string, hour12: boolean): string {
  const p = splitTimeOfDay(t);
  if (!p) return "";
  const mm = String(p.m).padStart(2, "0");
  if (!hour12) return `${String(p.h24).padStart(2, "0")}:${mm}`;
  const ap = p.h24 < 12 ? "AM" : "PM";
  const h = p.h24 % 12 === 0 ? 12 : p.h24 % 12;
  return `${h}:${mm} ${ap}`;
}

/** Picker parts back to "HH:MM", or null when incomplete. */
export function joinTimeParts(h: string, m: string, ap: "AM" | "PM" | null): string | null {
  if (!h || !m) return null;
  const hi = Number(h);
  const mi = Number(m);
  if (!Number.isInteger(hi) || !Number.isInteger(mi)) return null;
  let h24 = hi;
  if (ap !== null) {
    // 12-hour face: 12 AM is midnight, 12 PM is noon, everything else offsets.
    if (hi < 1 || hi > 12 || mi < 0 || mi > 59) return null;
    h24 = hi % 12 + (ap === "PM" ? 12 : 0);
  } else if (hi < 0 || hi > 23 || mi < 0 || mi > 59) {
    return null;
  }
  return `${String(h24).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** Which face the picker shows first: the operator's locale, defaulting to 12h. */
export function defaultHour12(): boolean {
  try {
    const cycle = new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hourCycle;
    if (cycle === "h23" || cycle === "h24") return false;
    return true;
  } catch {
    return true;
  }
}
