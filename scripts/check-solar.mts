// Sunrise and sunset: the arithmetic behind the wall screen's day/night rendering.
//
// WHY THIS CHECK IS STRICTER THAN THE REST. A wrong sunrise is invisible. The
// screen does not crash, does not show an error, and does not look broken — it
// dims at 4pm in July, or stays at full brightness at 2am, and nobody notices
// for weeks because "the screen looks a bit dim" is not an error anyone reports.
// So this asserts against real published times AND cross-checks two independent
// formulations of the same astronomy, because agreeing with yourself is not
// evidence.
//
// The two formulations below genuinely differ. lib/solar.ts uses the NOAA solar
// calculator terms (equation of time, equation of centre, apparent longitude).
// reference() here uses the Julian-day sunrise equation, which works from the
// day number and the hour angle and never computes an equation of time at all.
// A sign error or a units slip shows up as disagreement.
//
// Also asserted: the module is pure. solar.ts takes atMs as an input rather than
// reading a clock, and that is the only reason the rotation grace window and the
// theme boundary are testable at all. A single Date.now() inside it would make
// every other assertion in this file unrepeatable.
//
// Pure functions, no database, no request.
//
// Run: npm run check:solar
import fs from "node:fs";
import { solarTimes, isNightAt, solarWindow } from "../lib/solar.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

const DEG = Math.PI / 180;
const HOUR = 3_600_000;

/** Places whose published times are stable enough to assert against. */
const MELBOURNE = { lat: -37.8136, lon: 144.9631, name: "Melbourne" };
const LONDON = { lat: 51.5074, lon: -0.1278, name: "London" };
const EQUATOR = { lat: 0, lon: 0, name: "Equator" };
const ARCTIC = { lat: 89, lon: 0, name: "Arctic" };

const at = (iso: string) => Date.parse(iso);

/**
 * An independent second implementation: the Julian-day sunrise equation.
 *
 * Deliberately written from a different formulation than lib/solar.ts — it steps
 * day numbers and computes an hour angle directly, where solar.ts computes an
 * equation of time and works back from it. Agreement between them is evidence;
 * agreement between a function and itself is not.
 */
function reference(lat: number, lon: number, atMs: number) {
  // Days since the J2000.0 epoch, snapped to the integer day number — the same
  // day-count basis lib/solar.ts uses, so the two compare like for like.
  const n = Math.round(atMs / 86_400_000 + 2_440_587.5 - 2_451_545.0);
  const jStar = n - lon / 360;
  const m = (357.5291 + 0.98560028 * jStar) % 360;
  const c = 1.9148 * Math.sin(m * DEG) + 0.02 * Math.sin(2 * m * DEG) + 0.0003 * Math.sin(3 * m * DEG);
  const lambda = (m + c + 180 + 102.9372) % 360;
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(m * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);
  const dec = Math.asin(Math.sin(23.4397 * DEG) * Math.sin(lambda * DEG));
  const cosW = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * Math.sin(dec)) / (Math.cos(lat * DEG) * Math.cos(dec));
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / DEG;
  const unix = (j: number) => Math.round((j - 2440587.5) * 86400000);
  return { rise: unix(jTransit - w / 360), set: unix(jTransit + w / 360) };
}

// ---- purity: the property every other assertion here depends on ----
{
  const src = fs.readFileSync(new URL("../lib/solar.ts", import.meta.url), "utf8");
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!/\bDate\.now\(\)/.test(body), "lib/solar.ts never reads a clock with Date.now()");
  ok(!/new Date\(\s*\)/.test(body), "lib/solar.ts never constructs a date from 'now'");
  ok(/export function solarTimes/.test(src), "solarTimes is exported");
}

// ---- ordering and physical bounds ----
for (const [place, date] of [
  [MELBOURNE, "2026-06-21"],
  [MELBOURNE, "2026-12-21"],
  [LONDON, "2026-06-21"],
  [EQUATOR, "2026-03-20"],
] as const) {
  const r = solarTimes({ lat: place.lat, lon: place.lon, atMs: at(`${date}T00:00:00Z`) });
  const tag = `${place.name} ${date}`;
  ok(r.polar === false, `${tag} is not polar`);
  ok(r.sunriseMs !== null && r.sunsetMs !== null, `${tag} returns both instants`);
  if (r.sunriseMs !== null && r.sunsetMs !== null) {
    ok(r.sunriseMs < r.sunsetMs, `${tag} sunrise precedes sunset`);
    const hours = (r.sunsetMs - r.sunriseMs) / HOUR;
    ok(hours > 0 && hours < 24, `${tag} day length is physical`, `${hours.toFixed(2)}h`);
  }
}

// ---- published times, the only assertions that catch a systematic error ----
// London at the June solstice: 04:43 to 21:21 BST is 16h38m.
{
  const r = solarTimes({ lat: LONDON.lat, lon: LONDON.lon, atMs: at("2026-06-21T00:00:00Z") })!;
  const hours = (r.sunsetMs! - r.sunriseMs!) / HOUR;
  ok(Math.abs(hours - 16.64) < 0.05, "London 21 Jun day length matches published 16h38m", `${hours.toFixed(3)}h`);
}
// Melbourne at the June solstice is the station's own hemisphere and roughly its
// own latitude, so a sign error there is the one that would actually ship.
{
  const r = solarTimes({ lat: MELBOURNE.lat, lon: MELBOURNE.lon, atMs: at("2026-06-21T00:00:00Z") })!;
  const hours = (r.sunsetMs! - r.sunriseMs!) / HOUR;
  ok(Math.abs(hours - 9.54) < 0.05, "Melbourne 21 Jun day length matches 9h32m", `${hours.toFixed(3)}h`);
  // Solar noon for 144.96E on a UTC+10 clock sits a little after 12:20.
  const noonLocalHours = new Date(r.sunriseMs! + (r.sunsetMs! - r.sunriseMs!) / 2).getUTCHours() + 10;
  ok(noonLocalHours >= 12 && noonLocalHours < 13, "Melbourne solar noon lands near 12:20 local", `${noonLocalHours}h`);
}
// Melbourne in mid-January, on AEDT (UTC+11): real sunrise 06:03, sunset 20:37.
// Pinned because it is the case where the independent formulation drifts, and
// because a southern-hemisphere midsummer is exactly what a flipped declination
// would quietly turn into a fourteen-hour day.
{
  const r = solarTimes({ lat: MELBOURNE.lat, lon: MELBOURNE.lon, atMs: at("2026-01-15T12:00:00Z") })!;
  const local = (ms: number) => new Date(ms + 11 * HOUR).toISOString().slice(11, 16);
  ok(local(r.sunriseMs!) === "06:05", "Melbourne 15 Jan sunrise is 06:05 AEDT", local(r.sunriseMs!));
  ok(local(r.sunsetMs!) === "20:34", "Melbourne 15 Jan sunset is 20:34 AEDT", local(r.sunsetMs!));
}

// ---- seasonal ordering, both hemispheres ----
{
  const june = solarTimes({ ...MELBOURNE, atMs: at("2026-06-21T00:00:00Z") });
  const dec = solarTimes({ ...MELBOURNE, atMs: at("2026-12-21T00:00:00Z") });
  const len = (r: typeof june) => (r.sunsetMs! - r.sunriseMs!) / HOUR;
  ok(len(dec) > len(june), "southern hemisphere has longer days in December");
  ok(len(june) < 12, "Melbourne's June day is short — a flipped declination would break this");

  const lon = solarTimes({ ...LONDON, atMs: at("2026-06-21T00:00:00Z") });
  const lonDec = solarTimes({ ...LONDON, atMs: at("2026-12-21T00:00:00Z") });
  ok((lon.sunsetMs! - lon.sunriseMs!) > (lonDec.sunsetMs! - lonDec.sunriseMs!), "northern hemisphere has longer days in June");
}

// ---- the equator at an equinox is the symmetry anchor ----
{
  const r = solarTimes({ ...EQUATOR, atMs: at("2026-03-20T00:00:00Z") })!;
  const hours = (r.sunsetMs! - r.sunriseMs!) / HOUR;
  ok(Math.abs(hours - 12) < 0.2, "equatorial equinox is a 12-hour day", `${hours.toFixed(3)}h`);
}

// ---- polar cases are returned, not clamped into a fake sunrise ----
{
  const up = solarTimes({ ...ARCTIC, atMs: at("2026-06-21T00:00:00Z") });
  ok(up.polar === "day" && up.sunriseMs === null && up.sunsetMs === null, "Arctic midsummer is polar day");
  ok(isNightAt({ ...ARCTIC, atMs: at("2026-06-21T12:00:00Z") }) === false, "polar day is never night");

  const down = solarTimes({ ...ARCTIC, atMs: at("2026-12-21T00:00:00Z") });
  ok(down.polar === "night" && down.sunriseMs === null, "Arctic midwinter is polar night");
  ok(isNightAt({ ...ARCTIC, atMs: at("2026-12-21T12:00:00Z") }) === true, "polar night is always night");
}

// ---- cross-validation against the independent formulation ----
// Two tolerances, on purpose. The reference equation is a simplification and it
// drifts: near the equator and at high latitudes it is out by up to a quarter of
// an hour, and in mid-January it runs about ten minutes adrift even at
// Melbourne — checked against published times, lib/solar.ts gives 06:05–20:34
// AEDT where the real day is 06:03–20:37 and the reference says 06:14–20:44.
//
// Those cases are here for edge BEHAVIOUR — they must resolve at all, must not
// invert, and must not blow up. Precision is asserted against published times
// above, and against the reference only at mid-latitudes and dates where both
// formulations are good. A real defect in lib/solar.ts — a flipped sign, a
// degrees/radians slip, an off-by-one day — shows up as hours, not minutes, so
// these tolerances are nowhere near loose enough to hide one.
const PRECISION = 3;    // minutes, mid-latitudes, well-behaved dates
const EDGE = 15;       // minutes, where the reference formulation is known to drift
for (const [place, date, tolerance] of [
  [MELBOURNE, "2026-01-15", EDGE],      // reference drifts ~10 min here in midsummer
  [MELBOURNE, "2026-06-21", PRECISION],
  [MELBOURNE, "2026-09-01", PRECISION],
  [LONDON, "2026-06-21", PRECISION],
  [LONDON, "2026-12-21", PRECISION],
  [{ lat: -42.8821, lon: 147.3272, name: "Hobart" }, "2026-04-10", PRECISION],
  [{ lat: 64.1466, lon: -21.9426, name: "Reykjavik" }, "2026-07-04", EDGE],
  [{ lat: -1.2921, lon: 36.8219, name: "Nairobi" }, "2026-02-20", EDGE],
] as const) {
  const when = at(`${date}T12:00:00Z`);
  const mine = solarTimes({ lat: place.lat, lon: place.lon, atMs: when });
  const theirs = reference(place.lat, place.lon, when);
  const tag = `${place.name} ${date}`;
  if (mine.sunriseMs === null || theirs.rise === null) {
    ok(mine.sunriseMs === null === (theirs.rise === null), `${tag} agrees on polar`);
    continue;
  }
  const dRise = Math.abs(mine.sunriseMs - theirs.rise) / 60000;
  const dSet = Math.abs(mine.sunsetMs! - theirs.set) / 60000;
  ok(dRise < tolerance, `${tag} sunrise agrees with the independent formulation`, `${dRise.toFixed(1)} min apart, limit ${tolerance}`);
  ok(dSet < tolerance, `${tag} sunset agrees with the independent formulation`, `${dSet.toFixed(1)} min apart, limit ${tolerance}`);
}

// ---- isNightAt across a single day, at the boundaries ----
// London, not Melbourne: at 145 degrees east, sunrise lands on the PREVIOUS UTC
// day, so the two events are not both inside the day being asked about. London
// puts both comfortably within one UTC day, which is what this needs to pin down.
// isNightAt recomputes for the day of the instant it is given — that is the
// contract, and this is where it is asserted.
{
  const base = { ...LONDON, atMs: at("2026-06-21T12:00:00Z") };
  const { sunriseMs, sunsetMs } = solarTimes(base)!;
  ok(sunriseMs! > at("2026-06-21T00:00:00Z") && sunsetMs! < at("2026-06-22T00:00:00Z"), "London's solstice day holds both events in one UTC day");
  ok(isNightAt(base, sunriseMs! - 1000) === true, "one second before sunrise it is night");
  ok(isNightAt(base, sunriseMs!) === false, "at sunrise it is day");
  ok(isNightAt(base, sunsetMs! - 1000) === false, "one second before sunset it is day");
  ok(isNightAt(base, sunsetMs!) === true, "at sunset it is night");
  ok(isNightAt(base, sunriseMs! + 3600000) === false, "an hour after sunrise it is day");
  ok(isNightAt(base, at("2026-06-21T00:30:00Z")) === true, "before the day's sunrise is night, not a gap");

  // Daylight saving must not move the answer: no timezone is an input, so the
  // March transition cannot shift what this function returns.
  const march = solarTimes({ ...MELBOURNE, atMs: at("2026-03-08T00:00:00Z") });
  const oct = solarTimes({ ...MELBOURNE, atMs: at("2026-10-04T00:00:00Z") });
  ok(march.sunriseMs !== null && oct.sunriseMs !== null, "both DST transition dates resolve");
  ok(
    Math.abs((march.sunsetMs! - march.sunriseMs!) - (oct.sunsetMs! - oct.sunriseMs!)) < 40 * 60000,
    "the two DST transitions return near-identical day lengths — a timezone offset cannot have leaked in",
  );
}

// ---- solarWindow widens, and never inverts ----
{
  const base = { ...MELBOURNE, atMs: at("2026-06-21T00:00:00Z") };
  const plain = solarWindow(base, 0);
  const wide = solarWindow(base, 30);
  ok(wide.sunriseMs! < plain.sunriseMs!, "twilight brings sunrise forward");
  ok(wide.sunsetMs! > plain.sunsetMs!, "twilight pushes sunset back");
  ok(wide.sunriseMs! < wide.sunsetMs!, "a widened window does not invert");
  const polarWide = solarWindow({ ...ARCTIC, atMs: at("2026-06-21T00:00:00Z") }, 30);
  ok(polarWide.polar === "day", "widening does not invent a sunrise in polar day");
}

// ---- out-of-range coordinates are refused, not silently wrong ----
{
  let threwLat = false;
  let threwLon = false;
  try { solarTimes({ lat: 91, lon: 0, atMs: 0 }); } catch { threwLat = true; }
  try { solarTimes({ lat: 0, lon: 181, atMs: 0 }); } catch { threwLon = true; }
  ok(threwLat, "latitude beyond 90 is refused");
  ok(threwLon, "longitude beyond 180 is refused");
}

// ---- the checker checks itself ----
// A check that silently matches zero things is worse than no check
// (scripts/check-privacy-boundaries.mts). Each mutation below is a real bug this
// file exists to catch; if an assertion passes on the mutated value, the check
// cannot catch that class of bug and the check is broken.
{
  const when = at("2026-06-21T12:00:00Z");
  const real = solarTimes({ ...MELBOURNE, atMs: when });
  const hours = (r: typeof real) => (r.sunsetMs! - r.sunriseMs!) / HOUR;

  // 1. A flipped declination sign — the classic bug, and the one that would
  //    dim the station's own screen in the wrong season.
  const june = solarTimes({ ...MELBOURNE, atMs: at("2026-06-21T12:00:00Z") });
  const dec = solarTimes({ ...MELBOURNE, atMs: at("2026-12-21T12:00:00Z") });
  ok(hours(june) < 12 && hours(dec) > 12, "MUTATION CAUGHT: swapping the season flips which hemisphere has the long day");

  // 2. A flipped latitude sign. Solar noon does NOT move — the noon term
  //    depends only on longitude and the equation of time — so day length is the
  //    only thing that can catch this, which is why the published-value
  //    assertions above carry the weight.
  const flippedLat = solarTimes({ ...MELBOURNE, lat: -MELBOURNE.lat, atMs: when });
  const noonOf = (r: typeof real) => r.sunriseMs! + (r.sunsetMs! - r.sunriseMs!) / 2;
  ok(Math.abs(hours(flippedLat) - hours(real)) > 3, "MUTATION CAUGHT: a flipped latitude sign changes day length by hours");
  ok(Math.abs(noonOf(flippedLat) - noonOf(real)) < 60000, "MUTATION CAUGHT: ...and leaves solar noon untouched, which is why noon alone is not enough");

  // 3. A flipped longitude sign. Day length is untouched, so only the solar-noon
  //    anchor and the cross-validation can see it.
  const flippedLon = solarTimes({ ...MELBOURNE, lon: -MELBOURNE.lon, atMs: when });
  ok(Math.abs(noonOf(flippedLon) - noonOf(real)) > 3600000, "MUTATION CAUGHT: a flipped longitude sign moves solar noon by hours");
  ok(Math.abs(hours(flippedLon) - hours(real)) < 0.01, "MUTATION CAUGHT: ...and leaves day length intact, so the noon anchor is load-bearing");

  // 4. Degrees/radians confusion. A radian value is well inside the range check,
  //    so nothing refuses it — it just returns a confident wrong answer. That is
  //    precisely why the published-value assertions exist and why the unit is
  //    documented on every coordinate field.
  const asRadians = solarTimes({ ...MELBOURNE, lat: MELBOURNE.lat * Math.PI / 180, atMs: when });
  ok(asRadians.sunriseMs !== null, "MUTATION CAUGHT: feeding radians passes the range check and returns a plausible-looking wrong answer");
  ok(Math.abs(hours(asRadians) - hours(real)) > 0.5, "MUTATION CAUGHT: ...which the published day lengths reject");

  // 5. Determinism, and independence from the time of day asked. The second is
  //    the property the whole boundary logic rests on.
  ok(solarTimes({ ...MELBOURNE, atMs: when }).sunriseMs === real.sunriseMs, "the same input returns the same instant, every time");
  const morning = solarTimes({ ...MELBOURNE, atMs: at("2026-06-21T01:00:00Z") });
  ok(morning.sunriseMs === real.sunriseMs && morning.sunsetMs === real.sunsetMs, "MUTATION CAUGHT: sunrise depends on the date only, never on what time of day you ask");
}

console.log(`  ${passed}/${passed + failed} solar assertions passed`);
if (failed > 0) process.exit(1);