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

/**
 * Error classes NextAuth forces onto the signin page (its own allowlist
 * bypasses pages.error for these), plus the ones pages.error receives.
 * Grouped by what the human should hear, not by NextAuth's names.
 */
export const WAKING_DB_ERRORS: ReadonlySet<string> = new Set([
  "Callback",
  "OAuthCallback",
  "OAuthCreateAccount",
  "OAuthSignin",
  "Signin",
  "AdapterError",
  "default",
]);

export function isWakingDbError(code: string): boolean {
  return WAKING_DB_ERRORS.has(code);
}

/**
 * What the sign-in page should do about signing this browser in by itself.
 *
 * This exists as a decision function because the version that lived in the
 * component was an unbounded redirect loop, and the shape of the bug was the
 * shape of the code: a guard written on mount and deleted on unmount, while
 * `signIn()` navigates the whole document — so every trip to Google unmounted
 * the page that was guarding against the next trip. A listener who had ever
 * signed in could never load the station again; a browser that never had (or
 * incognito, with no cookie) never entered the loop at all.
 *
 * So: the page-level courtesy try is ONE attempt, on a plain visit only, and it
 * is bounded by a guard that nothing deletes on the way out. Once a real error
 * page is reached, recovery belongs to AuthFailure's retry loop, which has a
 * ceiling and a stop button — and reaching an error page means the courtesy try
 * did not work, so that guard is released rather than left to gag the loop.
 */
export type AutoSignInDecision =
  /** Wake the station, then start the Google flow. Once, ever, per tab. */
  | "attempt"
  /** Hand over to AuthFailure's bounded retry loop, and release the guard. */
  | "leave-to-retry-loop"
  /** Do nothing on our own initiative; the human presses the button. */
  | "leave-alone";

export function decideAutoSignIn(args: {
  /** Does this browser carry the remember-me cookie? */
  remembers: boolean;
  /** The NextAuth error code on the URL, or "" for a plain visit. */
  errorCode: string;
  /** Has the courtesy try already been spent in this tab? */
  alreadyAttempted: boolean;
}): AutoSignInDecision {
  // Never auto-fire for a browser we have never signed in.
  if (!args.remembers) return "leave-alone";

  if (args.errorCode) {
    // A rejected account is about approval, not about a sleeping database.
    // Retrying cannot fix it, and hammering Google on someone's behalf cannot
    // help them either.
    if (!isWakingDbError(args.errorCode)) return "leave-alone";
    // Unconditionally, alreadyAttempted or not: the error page is where the
    // bounded loop lives, and gating it on the guard is what left the earlier
    // version stuck on a countdown that could never move.
    return "leave-to-retry-loop";
  }

  // A plain visit: the whole point of the cookie, one time.
  return args.alreadyAttempted ? "leave-alone" : "attempt";
}

/**
 * Wake the station before leaning on Google. The OAuth round-trip is what the
 * station uses to pull a sleeping database up, so waking first is the difference
 * between one round-trip and thirty of them.
 */
export async function wakeStationDatabase(
  fetchImpl: typeof fetch = fetch,
  endpoint = "/api/auth/wake-db"
): Promise<boolean> {
  try {
    const res = await fetchImpl(endpoint, { method: "POST" });
    return !!res?.ok;
  } catch {
    // A failed wake is not a reason to skip the sign-in: the round-trip may
    // still succeed, and AuthFailure reports the real outcome either way.
    return false;
  }
}
