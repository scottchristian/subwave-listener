/**
 * The "this browser has been here before" cookie that lets a returning listener
 * be signed in by the app rather than by a button press.
 *
 * Its whole purpose is the arrival nobody can avoid: the station's database has
 * been asleep, `/api/auth/session` could not be answered, and the listener needs
 * the OAuth round-trip to happen whether or not they think to ask for it. So
 * the rules below are stated as functions rather than left in an effect, because
 * the mistake this file exists to prevent is subtle and was made once: treating
 * "the session read did not succeed" as "this browser signed out".
 */

/** Name on the wire. Deliberately not `__Host-`: it must be readable by script, which it is either way. */
export const REMEMBER_COOKIE = "subwave_remember";

/** A year: the point is "in the past", and expiry is the janitor, not the gate. */
export const REMEMBER_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Should the cookie be (re)written after a session read?
 *
 * Only an authenticated session writes it. Every other status is "keep whatever
 * is there" — and that is the whole point, because next-auth's SessionProvider
 * reports "unauthenticated" for a session fetch that FAILED (a sleeping database,
 * a dropped connection) exactly as it does for a session that genuinely ended.
 * The two are indistinguishable from here, so neither may delete anything: a
 * failed read must cost the listener nothing.
 *
 * Signing out is an explicit act with its own path (forgetRememberCookie), and
 * that is the only thing that removes the cookie.
 */
export function shouldWriteRememberCookie(status: unknown, hasCookie: boolean): boolean {
  return status === "authenticated" && !hasCookie;
}

/** `document.cookie` value that writes the cookie. Secure, Lax so the OAuth redirect carries it. */
export function rememberCookieHeader(maxAgeS: number = REMEMBER_MAX_AGE_S): string {
  return `${REMEMBER_COOKIE}=true; max-age=${maxAgeS}; path=/; secure; same-site=lax`;
}

/** `document.cookie` value that forgets it. Paired attributes, so the browser actually matches it. */
export function forgetRememberCookieHeader(): string {
  return `${REMEMBER_COOKIE}=; max-age=0; path=/; secure; same-site=lax`;
}

/** Whether this document already carries the cookie. */
export function hasRememberCookie(cookie: string): boolean {
  return cookie.split(";").some((c) => c.trim() === `${REMEMBER_COOKIE}=true`);
}
