/**
 * Sunrise and sunset, for the wall screen's day/night rendering.
 *
 * WHY THIS EXISTS AT ALL. The screen dims itself when the sun goes down, so it
 * needs to know when that is. It does NOT need to know what time it is in
 * daylight-saving terms or where the observer is — a wall display's job is to
 * decide "is it bright out", and "is it bright out" is a function of latitude,
 * longitude and the date. Nothing else.
 *
 * WHY THE OBSERVER'S TIMEZONE IS NOT AN INPUT. Every timezone bug that exists in
 * sunrise code exists because the function was handed a clock it then had to
 * reconcile against the sun. This one returns UTC instants and stops. The caller
 * formats them. That also means daylight saving cannot corrupt it: there is no
 * offset in here to be wrong, so the March and October transitions cannot move
 * the answer.
 *
 * WHY THE OBSERVER'S LONGITUDE IS WEST-NEGATIVE HERE. Astronomical convention:
 * north and east positive. Melbourne is 144.96 E, Sydney 151.2 E, London is -0.1.
 * Passing a signed number the wrong way round puts sunset in the morning, which
 * is the single most likely bug in a file like this, so the sign is asserted in
 * check-solar.mts rather than left to a code reader to verify.
 *
 * The algorithm is the standard sunrise/sunset equation: mean solar noon from the
 * equation of time, then an hour angle from the declination and the observer's
 * latitude. Accurate to about a minute for the purposes of dimming a screen.
 *
 * WHAT THIS IS NOT. It does not compute civil, nautical or astronomical
 * twilight as separate bands, and it does not take elevation into account
 * beyond the standard refraction allowance. `twilightMinutes` widens the window
 * either side, which is what the screen actually wants — the useful question is
 * "is it dark enough to want a dim screen", not "is the sun's centre exactly
 * half a degree below the horizon".
 */

const DEG = Math.PI / 180;

/**
 * Standard refraction + solar radius, in degrees. The sun is treated as a point
 * at the horizon, which is 0.833 degrees lower than it geometrically appears —
 * about half a degree of refraction and a quarter of a degree of the disc.
 */
const HORIZON_DEG = -0.833;

/** Obliquity of the ecliptic. Slow drift is negligible over a device lifetime. */
const OBLIQUITY_DEG = 23.4397;

/** Unix milliseconds to a Julian Day number. */
function julianDay(ms: number): number {
  return ms / 86_400_000 + 2_440_587.5;
}

export interface SolarInput {
  /** Degrees, north positive. −90 to 90. */
  lat: number;
  /** Degrees, east positive. −180 to 180. */
  lon: number;
  /** Any instant on the day of interest. Not read for its clock time. */
  atMs: number;
}

export interface SolarTimes {
  /** UTC epoch ms. Null when the sun does not cross the horizon that day. */
  sunriseMs: number | null;
  sunsetMs: number | null;
  /** True when the sun never crosses the horizon on this date. */
  polar: "day" | "night" | false;
}

export type SolarResult = SolarTimes;

/**
 * Sunrise and sunset for the date containing `atMs`, as UTC instants.
 *
 * Pure: `atMs` is an input, never `Date.now()`. That is what makes the rotation
 * and theme windows testable at all, and check-solar.mts asserts the property by
 * scanning this file for a hidden clock read.
 */
export function solarTimes(input: SolarInput): SolarTimes {
  const { lat, lon, atMs } = input;
  assertValid(input);

  // Snap to the integer Julian day number BEFORE computing anything. The
  // standard formulation works from a day count, not a wall-clock instant, and
  // that matters more than it looks: deriving the century from the fractional
  // instant instead makes the answer drift by a minute or two depending on what
  // time of day you asked about. A wall display asks about a moment and then
  // compares it against its own sunrise, so sunrise must depend on the DATE and
  // nothing else — otherwise an instant a hair before sunrise can compute a
  // slightly earlier sunrise and read as night forever.
  const jdNoon = Math.floor(julianDay(atMs) + 0.5);
  const dayStart = jdNoon - 0.5; // Julian Day at 00:00 UTC of that day

  // Julian centuries since J2000.0, measured from noon.
  const t = (jdNoon - 2_451_545.0) / 36_525;

  // Geometric mean longitude and anomaly of the sun.
  const l0 = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35_999.05029 - 0.0001537 * t);

  // Equation of centre, in degrees.
  const c =
    Math.sin(m * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * DEG) * 0.000289;

  // True and apparent longitude.
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Obliquity, corrected for nutation.
  const meanObliq =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * DEG);

  // Solar declination. sin(delta) = sin(obliquity) * sin(apparent longitude).
  const decl = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG));

  // Equation of time, in minutes of solar time ahead of mean solar time.
  const y = Math.tan((obliq / 2) * DEG) ** 2;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * DEG) -
      2 * 0.016708634 * Math.sin(m * DEG) +
      4 * 0.016708634 * y * Math.sin(m * DEG) * Math.cos(2 * l0 * DEG) -
      0.5 * y * y * Math.sin(4 * l0 * DEG) -
      1.25 * 0.016708634 * 0.016708634 * Math.sin(2 * m * DEG));

  // Solar noon in minutes UTC. Longitude is east-positive, so east of Greenwich
  // is subtracted: the sun reaches its meridian earlier there.
  const solarNoonMin = 720 - 4 * lon - eqTime;

  // Hour angle at which the sun sits on the horizon, in degrees.
  const cosH =
    (Math.sin(HORIZON_DEG * DEG) - Math.sin(lat * DEG) * Math.sin(decl)) /
    (Math.cos(lat * DEG) * Math.cos(decl));

  // Outside [-1, 1] the sun never reaches that angle: it is up all day, or down
  // all day. Both are real — a screen in Longyearbyen in June has no night, and
  // one in December has no day — so they are returned rather than clamped into
  // a fake sunrise that would flicker the display at the wrong time.
  if (cosH > 1) return { sunriseMs: null, sunsetMs: null, polar: "night" };
  if (cosH < -1) return { sunriseMs: null, sunsetMs: null, polar: "day" };

  const ha = Math.acos(cosH) / DEG;

  // Noon instant, in UTC ms, on the same day.
  const noonMs = (dayStart - 2_440_587.5) * 86_400_000 + solarNoonMin * 60_000;
  const haMs = (ha / 360) * 86_400_000;

  return {
    sunriseMs: Math.round(noonMs - haMs),
    sunsetMs: Math.round(noonMs + haMs),
    polar: false,
  };
}

/**
 * Is this instant dark, at this place?
 *
 * Deliberately simpler than it looks. "Before today's sunrise" and "after today's
 * sunset" are both night, without any need to fetch the previous day's times —
 * so there is no second call, no iteration, and no edge case at midnight where
 * the two days disagree about which is "today".
 *
 * Polar day is never night. Polar night is always night, and there is no
 * meaningful alternative: the screen should be dim.
 *
 * The boundary belongs to the state it enters: at the instant of sunrise it is
 * day, and at the instant of sunset it is night. That is symmetric, and it means
 * a screen sitting exactly on its own sunset timestamp has already dimmed.
 */
export function isNightAt(input: SolarInput, atMs: number = input.atMs): boolean {
  const { sunriseMs, sunsetMs, polar } = solarTimes({ ...input, atMs });

  if (polar === "day") return false;
  if (polar === "night") return true;
  if (sunriseMs === null || sunsetMs === null) return false;

  return atMs < sunriseMs || atMs >= sunsetMs;
}

/**
 * The day's sunrise and sunset, widened by `twilightMinutes` at each end.
 *
 * A screen dimming at the exact instant the sun clears the horizon is wrong in
 * the useful direction: rooms are still bright then. Widening the window is how
 * "is it dark out" becomes a question about a room rather than about astronomy.
 */
export function solarWindow(
  input: SolarInput,
  twilightMinutes = 30,
): SolarTimes {
  const base = solarTimes(input);
  if (base.polar || base.sunriseMs === null || base.sunsetMs === null) return base;
  const pad = twilightMinutes * 60_000;
  return {
    sunriseMs: base.sunriseMs - pad,
    sunsetMs: base.sunsetMs + pad,
    polar: base.polar,
  };
}

/** Bounds check. A bad coordinate here silently produces a wrong sunset forever. */
function assertValid({ lat, lon }: SolarInput): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`longitude out of range: ${lon}`);
  }
}