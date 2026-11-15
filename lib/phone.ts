/**
 * Phone-number handling for the listener text line.
 *
 * PURE: no fetch, no env, no clock. The route supplies the station's default
 * country from its own timezone, and the result is E.164 or null. Both shapes
 * people actually type must work: "0408 344 123" and "+61 408 344 123" are the
 * same number, and the second is what Linq accepts.
 */

import { AsYouType, type CountryCode } from "libphonenumber-js/min";

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

/** Join digits into the given chunk sizes; a partial tail becomes its own chunk. */
function grouped(digits: string, sizes: number[]): string {
  const out: string[] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + size));
    i += size;
  }
  if (i < digits.length) out.push(digits.slice(i));
  return out.join(" ");
}

/**
 * What the listener sees while typing, in their country's own shape:
 * "0408826585" (AU) becomes "0408 826 585", "021555123" (NZ) "021 555 123",
 * "4088265855" (US) "(408) 826-5855". `iso` is the country the picker shows.
 *
 * Cosmetic only. Spaces and punctuation are discarded by normalizePhone, so
 * the returned string is safe to submit as typed. A number that already
 * carries a country code is formatted as international; one from another
 * country is left as typed.
 */
export function formatPhoneInput(raw: string, iso?: string | null): string {
  const input = String(raw ?? "");
  if (!input.trim()) return "";
  const formatted = new AsYouType((iso || undefined) as CountryCode | undefined).input(input);
  // AsYouType leaves a national number it can't classify untouched. Grouping
  // bare digits in threes keeps them readable without moving a digit — the
  // server still completes the country code.
  if (formatted === input && /^\d{6,}$/.test(input)) return grouped(input, [3, 3, 3]);
  return formatted;
}

/**
 * The carrier opt-out keywords. Standard ones must be the WHOLE message and
 * exactly the spelled token; OPT OUT is the exception and tolerates casing,
 * spacing and hyphens. A clear "stop texting me" counts too — Linq's own
 * guidance puts conversational stop requests in the code's hands.
 */
const OPT_OUT_EXACT = new Set(["STOP", "UNSUBSCRIBE", "OPTOUT", "CANCEL", "END", "QUIT"]);
const STOP_REQUEST =
  /^(?:please\s+)?(?:stop\s+(?:texting|messaging|contacting)\s+me|(?:do\s+not|don'?t)\s+(?:text|message|contact)\s+me)(?:\s+please)?\s*[.!]*$/i;

export function isOptOut(body: string): boolean {
  const text = String(body || "").trim();
  if (!text) return false;
  if (OPT_OUT_EXACT.has(text)) return true;
  if (/^opt[\s-]*out$/i.test(text)) return true;
  return STOP_REQUEST.test(text);
}

/** Six digits, nothing else. */
export function isVerificationCode(raw: string): boolean {
  return /^\d{6}$/.test(String(raw || "").trim());
}
