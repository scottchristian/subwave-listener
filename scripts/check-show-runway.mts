// The On The Air card's runway: who is on air, until when, and what follows.
//
// The bug this exists for: the runway was computed from the weekly grid only.
// The station resolves who is on air by TIMED TAKEOVER first and grid second, so
// when an operator pinned a different show to the air, the card's header (from
// /now-playing) moved on while the until/next lines underneath went on counting
// the replaced show's hour. Manual takeover looked ignored.
//
// Everything here is time-injected, so the boundary minutes are asserted rather
// than hoped for.
// Run: node scripts/check-show-runway.mts (wired as `npm run check:show-runway`).
import { computeShowRunway } from "../lib/show-runway.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

const TZ = "Australia/Hobart";
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Epoch ms for a station wall-clock moment. Hobart is UTC+11 year-round here. */
function at(day: number, hour: number, minute = 0): number {
  // 2026-10-04 is a Sunday, so day 0 = the 4th.
  return Date.UTC(2026, 9, 4 + day, hour - 11, minute);
}

const personas = [
  { id: "p_sam", name: "Sam", avatar: "/persona-avatar/p_sam" },
  { id: "p_owen", name: "Owen", avatar: "/persona-avatar/p_owen" },
  { id: "p_jax", name: "Jax", avatar: "/persona-avatar/p_jax" },
];
const shows = [
  { id: "show_evening", name: "The Evening Wind Down", personaId: "p_sam" },
  { id: "show_night", name: "Night Shift", personaId: "p_owen" },
  { id: "show_special", name: "Sam's Tourettes Hour", personaId: "p_jax" },
];

/** Sunday 18:00–22:00 evening show, 22:00–24:00 night shift. */
function grid(): Record<string, unknown> {
  const day = new Array(24).fill(null);
  for (let h = 18; h < 22; h++) day[h] = "show_evening";
  for (let h = 22; h < 24; h++) day[h] = "show_night";
  const g: Record<string, unknown> = {};
  for (let d = 0; d < 7; d++) g[String(d)] = day.slice();
  return g;
}

const base = { grid: grid(), shows, personas, timezone: TZ };

// ---------------------------------------------------------------- grid mode

{
  const r = computeShowRunway({ ...base, override: null, now: at(0, 19, 30) });
  ok(r?.mode === "grid", "no override -> the timetable decides", r?.mode);
  ok(r?.leftMin === 150, "19:30 into an 18:00-22:00 show is 2h30m left", r?.leftMin);
  ok(r?.nextName === "Night Shift", "and Night Shift is what follows", r?.nextName);
  ok(r?.nextHost === "Owen", "with the host who fronts it", r?.nextHost);
  ok(r?.nextIsResume === false, "which is a successor, not a resumption", r?.nextIsResume);
}

{
  // Exactly on the hour mark: the new show is on air and the runway is its own.
  const r = computeShowRunway({ ...base, override: null, now: at(0, 22, 0) });
  ok(r?.leftMin === 120, "22:00 is the first minute of Night Shift, so it has its full two hours", r?.leftMin);
  ok(r?.nextName === null, "and nothing is painted after it, so no successor is invented", r?.nextName);
}

{
  // Nothing painted for this hour: say nothing rather than invent a runway.
  const empty = { ...base, grid: (() => { const g = grid(); for (const k of Object.keys(g)) g[k] = new Array(24).fill(null); return g; })() };
  ok(computeShowRunway({ ...empty, override: null, now: at(0, 6, 0) }) === null, "an unpainted hour has no runway to report");
}

// ----------------------------------------------------------------- takeover

{
  // THE REGRESSION: an operator pins a different show for 30 minutes.
  const r = computeShowRunway({
    ...base,
    override: { showId: "show_special", startedAt: at(0, 19, 0), expiresAt: at(0, 19, 30) },
    now: at(0, 19, 10),
  });
  ok(r?.mode === "takeover", "a live pin is in force", r?.mode);
  ok(r?.leftMin === 20, "and it ends at the pin, not at the grid's hour mark", r?.leftMin);
  ok(r?.endMs === at(0, 19, 30), "endMs is the expiry instant", r?.endMs);
  ok(r?.nextName === "The Evening Wind Down", "what resumes is the show the pin interrupted", r?.nextName);
  ok(r?.nextIsResume === true, "and the card words it as a resumption, not 'Next'", r?.nextIsResume);
  ok(r?.nextHost === "Sam", "with Sam back on", r?.nextHost);
}

{
  // A pin that expires exactly now is over. Exclusive end, same as the station.
  const r = computeShowRunway({
    ...base,
    override: { showId: "show_special", startedAt: at(0, 19, 0), expiresAt: at(0, 19, 30) },
    now: at(0, 19, 30),
  });
  ok(r?.mode === "grid", "the pin's end instant belongs to the timetable again", r?.mode);
  ok(r?.nextName === "Night Shift", "so the grid's successor is back", r?.nextName);
}

{
  // Before it starts: the grid still owns the hour.
  const r = computeShowRunway({
    ...base,
    override: { showId: "show_special", startedAt: at(0, 20, 0), expiresAt: at(0, 20, 30) },
    now: at(0, 19, 45),
  });
  ok(r?.mode === "grid", "a pin that has not started changes nothing", r?.mode);
}

{
  // An expired pin is never passed through by /api/schedule, but do not trust it.
  const r = computeShowRunway({
    ...base,
    override: { showId: "show_special", startedAt: at(0, 18, 0), expiresAt: at(0, 18, 30) },
    now: at(0, 19, 0),
  });
  ok(r?.mode === "grid", "an expired pin is ignored", r?.mode);
}

{
  // "Default programming" pins nothing, but the window still closes at expiry.
  const r = computeShowRunway({
    ...base,
    override: { showId: null, startedAt: at(0, 19, 0), expiresAt: at(0, 19, 20) },
    now: at(0, 19, 5),
  });
  ok(r?.mode === "default-takeover", "a null target is a Default-programming pin, not no pin", r?.mode);
  ok(r?.endMs === at(0, 19, 20), "which still ends at its expiry", r?.endMs);
  ok(r?.nextName === "Night Shift", "and the timetable still names what follows", r?.nextName);
  ok(r?.nextIsResume === false, "because nothing was replaced", r?.nextIsResume);
}

{
  // A show deleted mid-pin: the station voids the override, so the card must too.
  const r = computeShowRunway({
    ...base,
    override: { showId: "show_deleted", startedAt: at(0, 19, 0), expiresAt: at(0, 19, 30) },
    now: at(0, 19, 10),
  });
  ok(r?.mode === "grid", "a dangling pin target falls back to the timetable", r?.mode);
  ok(r?.leftMin === 170, "and is timed by the timetable's hour mark, 19:10 to 22:00", r?.leftMin);
}

{
  // Crosses midnight: the scan must roll the day over, not lose the runway.
  const late = (() => {
    const g = grid();
    const sunday: (string | null)[] = new Array(24).fill(null);
    for (let h = 22; h < 24; h++) sunday[h] = "show_night";
    const monday: (string | null)[] = new Array(24).fill(null);
    monday[0] = "show_night";
    monday[1] = "show_night";
    for (let h = 2; h < 5; h++) monday[h] = "show_evening";
    g["0"] = sunday;
    g["1"] = monday;
    return g;
  })();
  const r = computeShowRunway({ ...base, grid: late, override: null, now: at(0, 23, 30) });
  ok(r?.mode === "grid", "a slot that runs across midnight still reports", r?.mode);
  ok(r?.leftMin === 150, "23:30 to a 02:00 change is 2h30m, counted over the day boundary", r?.leftMin);
  ok(r?.nextName === "The Evening Wind Down", "and the next day's show is named", r?.nextName);
}

// --------------------------------------------------------------- resilience

ok(computeShowRunway({ ...base, timezone: null, override: null, now: at(0, 19, 0) }) === null, "no timezone -> no runway, no throw");
ok(computeShowRunway({ ...base, timezone: "Not/AZone", override: null, now: at(0, 19, 0) }) === null, "a broken zone -> no runway, no throw");
ok(
  computeShowRunway({ ...base, grid: { "0": "not-a-row" } as any, override: null, now: at(0, 19, 0) }) === null,
  "a grid row that is not an array -> no runway, no throw"
);
ok(
  computeShowRunway({ ...base, override: { showId: "show_special", startedAt: NaN, expiresAt: NaN }, now: at(0, 19, 0) })?.mode === "grid",
  "an override with no usable instants is treated as absent"
);
ok(
  computeShowRunway({ ...base, personas: [], override: null, now: at(0, 19, 0) })?.nextName === "Night Shift",
  "a missing persona roster costs the host name, not the show"
);

console.log(`  ${passed}/${passed + failed} show-runway assertions passed`);
if (failed) process.exit(1);
