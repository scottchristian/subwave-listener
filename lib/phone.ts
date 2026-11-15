/**
 * Phone-number handling for the listener text line.
 *
 * PURE: no fetch, no env, no clock. The route supplies the station's default
 * country from its own timezone, and the result is E.164 or null. Both shapes
 * people actually type must work: "0408 344 123" and "+61 408 344 123" are the
 * same number, and the second is what Linq accepts.
 */

/** Dial code for a station timezone. Unknown places return "" — never guess. */
const DIAL_CODES: Record<string, string> = {
  "australia/sydney": "+61",
  "australia/melbourne": "+61",
  "australia/brisbane": "+61",
  "australia/perth": "+61",
  "australia/adelaide": "+61",
  "australia/hobart": "+61",
  "australia/darwin": "+61",
  "australia/canberra": "+61",
  "pacific/auckland": "+64",
  "europe/london": "+44",
  "europe/dublin": "+353",
  "europe/berlin": "+49",
  "europe/paris": "+33",
  "europe/amsterdam": "+31",
  "europe/madrid": "+34",
  "europe/rome": "+39",
  "europe/stockholm": "+46",
  "europe/oslo": "+47",
  "europe/copenhagen": "+45",
  "europe/helsinki": "+358",
  "america/new_york": "+1",
  "america/chicago": "+1",
  "america/denver": "+1",
  "america/los_angeles": "+1",
  "america/phoenix": "+1",
  "america/anchorage": "+1",
  "america/toronto": "+1",
  "america/vancouver": "+1",
  "america/halifax": "+1",
  "america/winnipeg": "+1",
  "america/edmonton": "+1",
  "america/sao_paulo": "+55",
  "america/mexico_city": "+52",
  "america/argentina/buenos_aires": "+54",
  "asia/tokyo": "+81",
  "asia/singapore": "+65",
  "asia/hong_kong": "+852",
  "asia/kolkata": "+91",
  "asia/jakarta": "+62",
  "asia/manila": "+63",
  "asia/kuala_lumpur": "+60",
  "africa/johannesburg": "+27",
};

export function dialCodeForTimezone(timezone: string | null | undefined): string {
  const tz = String(timezone || "").trim().toLowerCase();
  if (!tz) return "";
  if (DIAL_CODES[tz]) return DIAL_CODES[tz];
  // An unlisted America/* zone is overwhelmingly +1; anything else is not
  // guessed, because a wrong country code silently texts a stranger.
  if (tz.startsWith("america/")) return "+1";
  if (tz.startsWith("australia/")) return "+61";
  return "";
}

const DIGITS = /^\d+$/;

/**
 * E.164 or null. Accepts +CC…, 00CC…, a leading-zero national number in the
 * station's country, or a bare national number; a number that already carries
 * the country code without a plus is left as it is rather than doubled.
 */
export function normalizePhone(raw: string, defaultCountry?: string | null): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || /[^\d+\s().-]/.test(s)) return null;
  s = s.replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  const cc = String(defaultCountry || "").replace(/\D/g, "");

  if (s.startsWith("+")) {
    const digits = s.slice(1);
    return DIGITS.test(digits) && digits.length >= 8 && digits.length <= 15 ? "+" + digits : null;
  }
  if (!DIGITS.test(s) || !cc) return null;
  if (s.startsWith("0")) s = cc + s.replace(/^0+/, "");
  else if (!s.startsWith(cc)) s = cc + s;
  return s.length >= 8 && s.length <= 15 ? "+" + s : null;
}

/**
 * The carrier opt-out keywords. Standard ones must be the WHOLE message and
 * exactly the spelled token; OPT OUT is the exception and tolerates casing,
 * spacing and hyphens. Anything else is an ordinary request.
 */
const OPT_OUT_EXACT = new Set(["STOP", "UNSUBSCRIBE", "OPTOUT", "CANCEL", "END", "QUIT"]);

export function isOptOut(body: string): boolean {
  const text = String(body || "").trim();
  if (!text) return false;
  if (OPT_OUT_EXACT.has(text)) return true;
  return /^opt[\s-]*out$/i.test(text);
}

/** Six digits, nothing else. */
export function isVerificationCode(raw: string): boolean {
  return /^\d{6}$/.test(String(raw || "").trim());
}
