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
  { path: "/api/auth", why: "the login flow" },
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
 */
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

  const { default: prisma } = await import("@/lib/prisma");
  const session = await prisma.session
    .findUnique({ where: { sessionToken: token }, select: { expires: true } })
    .catch(() => null);
  if (!session) return false;
  return session.expires.getTime() > Date.now();
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  if (await isSetupOpen(pathname)) return NextResponse.next();

  if (await hasSession(req)) return NextResponse.next();

  // An API caller wants an answer, not a login page. The client code already
  // treats 401 as "not signed in" everywhere it matters.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A page: send them to the front page, which carries the sign-in button.
  // A redirect rather than a 401 so the browser gets real HTML.
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("signin", "required");
  return NextResponse.redirect(url);
}
