import { NextResponse, type NextRequest } from "next/server";

// Anonymous visitors get the front page and the ability to sign in. Nothing
// else. The admin dashboard and the likes page render their HTML shell to
// anyone who asks and rely on a client-side redirect, which is not a lock —
// anyone can read the source and the API responses behind it. So the lock goes
// here, in front of the route.
//
// Next 16 renamed this file convention from `middleware` to `proxy`, and the
// exported function must be named `proxy` (or be a default export) or the file
// is ignored SILENTLY. An ignored auth gate fails OPEN — the worst possible
// failure for this file — so the gate is re-verified from outside after every
// deploy, not assumed from a clean build.
export const config = {
  matcher: ["/admin/:path*", "/likes/:path*", "/api/:path*", "/setup/:path*"],
};

// Paths that must stay open, and why each one is a genuine exception.
const PUBLIC = [
  // NextAuth's own routes: signing in is the one thing a stranger must be able
  // to do. Covers /signin, /callback, /csrf, /providers, /session.
  { path: "/api/auth", why: "signing in is the one thing a stranger must be able to do" },
  // Polled by the Sub/Wave host, which authenticates with the station password
  // rather than a session — the route does its own check. Excluding it here
  // does not open it to the public.
  { path: "/api/donations/recent", why: "host-to-host poll, route checks the station password" },
  // Buy Me A Coffee posts here from the internet, so it cannot present a
  // session. It was NOT on this list, which meant the auth gate answered 401
  // before the route ever ran — so no real delivery could ever have arrived, and
  // the donations on record did not come from this path.
  //
  // Opening it does not make it public. The route accepts a payload only when it
  // carries an HMAC-SHA256 of its own body signed with the shared webhook
  // secret, which nothing but Buy Me A Coffee can produce. An unsigned or
  // wrongly-signed body is refused, and a missing secret refuses everything.
  { path: "/api/webhooks/bmac", why: "external webhook delivery; route verifies the signed body" },
  // Browser crash reports. It has to be open: the failure it exists to report is
  // very often a broken sign-in, and a reporter behind the auth gate drops
  // precisely the reports that matter most. It grants nothing — it reads no
  // session, touches no station state, and writes one capped line about a
  // render crash to a local file. It is publicly WRITABLE, so the route caps
  // every field, truncates the entry, and stops appending at LOG_MAX_BYTES.
  { path: "/api/client-error", why: "crash reporter; writes a capped line to local disk, reads nothing" },
];

const isPublic = (pathname: string) =>
  PUBLIC.some((p) => pathname === p.path || pathname.startsWith(p.path + "/"));

/**
 * The setup wizard, and only while it is still needed.
 *
 * The wizard writes Google credentials and the admin email address. If its
 * routes stayed reachable after setup finished, anyone who found the URL could
 * repoint the station at their own Google account and sign in as its
 * administrator — so this is conditional, and the condition is a marker file on
 * disk rather than anything the wizard itself reports.
 *
 * Once setup is complete this returns false, and /setup and /api/setup are gated
 * exactly like every other route: no session, no entry. The wizard page still
 * exists on disk; it is simply unreachable, which is the same posture the admin
 * dashboard is in.
 */
async function isSetupOpen(pathname: string): Promise<boolean> {
  try {
    const { isSetupOpenFor } = await import("@/lib/setup");
    return isSetupOpenFor(pathname);
  } catch {
    // If the check itself cannot run, fail CLOSED. Guessing "open" here would
    // expose the credential-writing routes on a broken deployment.
    return false;
  }
}

// The session cookie name, which carries a __Secure- prefix when the site is
// HTTPS. Both are accepted so the gate behaves the same on a plain-HTTP host.
const COOKIE_NAMES = ["__Secure-next-auth.session-token", "next-auth.session-token"];

/**
 * Is this request from a signed-in listener?
 *
 * NOT `getToken` from next-auth/jwt. That helper decrypts a JWE, which is only
 * what the cookie holds under `session.strategy: "jwt"`. This app uses
 * `strategy: "database"`, where next-auth's own source states the cookie is
 * "the sessionToken of the session in the database" — a bare UUID, not a JWE.
 * Feeding that to getToken fails with "Invalid Compact JWE" for every real
 * user, which locked the admin dashboard while looking correctly closed to
 * anonymous callers. So the cookie value is looked up the way the app itself
 * looks it up: as a sessionToken row.
 *
 * The answer is cached in memory (60s per token) because this gate runs on
 * EVERY page and API request — without it, a single open tab costs a session
 * lookup every 15s around the clock, which is exactly the idle database
 * traffic the free plan forbids. The trade is a ≤60s delay on revocation:
 * routes re-verify via getServerSession themselves, so a revoked caller that
 * slips the gate still gets a 401 where it matters. Signing out clears the
 * entry (see below), so that path is immediate.
 */
const sessionCache = new Map<string, { ok: boolean; at: number }>();
const SESSION_CACHE_MS = 60_000;
const SESSION_NEGATIVE_MS = 5_000;
const SESSION_CACHE_MAX = 1000;
async function hasSession(req: NextRequest): Promise<boolean> {
  let token: string | undefined;
  for (const name of COOKIE_NAMES) {
    const v = req.cookies.get(name)?.value;
    if (v) {
      token = v;
      break;
    }
  }
  if (!token) return false;

  const now = Date.now();
  const hit = sessionCache.get(token);
  if (hit && now - hit.at < (hit.ok ? SESSION_CACHE_MS : SESSION_NEGATIVE_MS)) {
    if (hit.ok) noteDbSuccess();
    return hit.ok;
  }
  const remember = (ok: boolean) => {
    if (sessionCache.size >= SESSION_CACHE_MAX) {
      const oldest = sessionCache.keys().next();
      if (!oldest.done) sessionCache.delete(oldest.value);
    }
    sessionCache.set(token, { ok, at: Date.now() });
  };

  const { default: prisma } = await import("@/lib/prisma");
  let session;
  try {
    session = await prisma.session.findUnique({ where: { sessionToken: token }, select: { expires: true } });
  } catch {
    // The database itself is unreachable (asleep, paused, gone) — not "no
    // session". Start the wake loop so this visit helps bring it back, and
    // count it: enough consecutive failures means the unavailable page.
    const { wakeDbInBackground } = await import("@/lib/dbwake");
    wakeDbInBackground();
    noteDbFailure();
    remember(false);
    return false;
  }
  if (!session) {
    remember(false);
    return false;
  }
  noteDbSuccess();
  const ok = session.expires.getTime() > Date.now();
  remember(ok);
  return ok;
}

/**
 * Consecutive session-lookup database failures, across requests. A handful in
 * a row means the database is down rather than one query hiccuping — past
 * that point, bouncing logged-in users to the sign-in prompt lies (sign-in
 * cannot work either), so they get the unavailable page instead. Anonymous
 * visitors (no cookie at all) never count: nothing is wrong for them yet.
 */
let dbFailStreak = 0;
const DB_DEAD_AFTER = 5;
function noteDbFailure(): void {
  dbFailStreak++;
}
function noteDbSuccess(): void {
  dbFailStreak = 0;
}
function dbLooksDead(): boolean {
  return dbFailStreak >= DB_DEAD_AFTER;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) {
    // Auth routes mutate sessions (sign-out deletes the row): drop any cached
    // answer for the presented token so the gate never contradicts what just
    // happened. Runs rarely — only the login flow comes here.
    if (pathname.startsWith("/api/auth")) {
      for (const name of COOKIE_NAMES) {
        const v = req.cookies.get(name)?.value;
        if (v) sessionCache.delete(v);
      }
    }
    return NextResponse.next();
  }

  if (await isSetupOpen(pathname)) return NextResponse.next();

  if (await hasSession(req)) return NextResponse.next();

  // An API caller wants an answer, not a login page. The client code already
  // treats 401 as "not signed in" everywhere it matters.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The database itself is down (not merely "no session"): the sign-in prompt
  // would be a lie, because signing in cannot work either. The unavailable
  // page explains, retries on its own, and sends them back when it lifts.
  // Only for callers who presented a session cookie — anonymous visitors keep
  // the normal front page, which needs no database to ask them to sign in.
  const presentedToken = COOKIE_NAMES.some((name) => req.cookies.get(name)?.value);
  if (presentedToken && dbLooksDead()) {
    const url = req.nextUrl.clone();
    url.pathname = "/unavailable";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // A page: send them to the front page, which carries the sign-in button.
  // A redirect rather than a 401 so the browser gets real HTML.
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("signin", "required");
  return NextResponse.redirect(url);
}
