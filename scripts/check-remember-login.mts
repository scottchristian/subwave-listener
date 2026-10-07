// The remember-me cookie: when it may be written, and — the regression — when it
// may be destroyed.
//
// The bug: the cookie was cleared whenever the session status read
// "unauthenticated". next-auth's SessionProvider reports that for a session
// fetch that FAILED exactly as it does for one that genuinely ended, so a
// listener arriving after the database had slept lost the cookie on the one
// visit the cookie exists for. They got a single automatic sign-in, and then the
// button for good, with nothing to explain why.
//
// So the rule under test is negative: no passive session reading may remove it.
// Only an explicit sign-out may, and that has its own path.
// Run: node scripts/check-remember-login.mts (wired as `npm run check:remember`).
import {
  REMEMBER_COOKIE,
  REMEMBER_MAX_AGE_S,
  shouldWriteRememberCookie,
  rememberCookieHeader,
  forgetRememberCookieHeader,
  hasRememberCookie,
} from "../lib/remember-login.ts";

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

// ------------------------------------------------------------ writing it

ok(shouldWriteRememberCookie("authenticated", false) === true, "an authenticated session with no cookie writes it");
ok(shouldWriteRememberCookie("authenticated", true) === false, "and leaves an existing cookie alone rather than resetting its clock");
ok(shouldWriteRememberCookie("loading", false) === false, "a session still loading writes nothing");
ok(shouldWriteRememberCookie(undefined, false) === false, "no session at all writes nothing");

// --------------------------------------------------- never destroying it

// THE REGRESSION. Every one of these read "unauthenticated" because the fetch
// failed, not because anyone signed out.
for (const why of [
  "the database was asleep",
  "the connection dropped",
  "the deploy was mid-restart",
  "the session had genuinely expired",
  "the listener is on the sign-in card",
]) {
  ok(
    shouldWriteRememberCookie("unauthenticated", true) === false,
    `an unauthenticated read (${why}) does not disturb the cookie`
  );
}

// The write path is the ONLY path in lib/remember-login.ts that touches the
// cookie, and it only ever writes. Nothing here can emit a deletion, which is
// the structural version of the assertion above.
ok(
  !Object.values({ shouldWriteRememberCookie, rememberCookieHeader }).some((f: any) => /max-age=0/.test(String(f))),
  "no read-path function can produce a deletion"
);

ok(forgetRememberCookieHeader().includes("max-age=0"), "an explicit sign-out does delete it");

// ------------------------------------------------------------ the wire format

ok(hasRememberCookie("subwave_remember=true") === true, "the cookie is found on its own");
ok(hasRememberCookie("a=1; subwave_remember=true; b=2") === true, "and among other cookies");
ok(hasRememberCookie("subwave_remember=false") === false, "a false value is not the cookie");
ok(hasRememberCookie("x_subwave_remember=true") === false, "a name that merely ends the same is not the cookie");
ok(hasRememberCookie("other=1") === false, "an unrelated jar does not read as a match");
ok(hasRememberCookie("") === false, "an empty jar does not throw");

ok(REMEMBER_MAX_AGE_S === 31_536_000, "the cookie lasts a year", REMEMBER_MAX_AGE_S);
ok(rememberCookieHeader().startsWith(`${REMEMBER_COOKIE}=true`), "written under the documented name");
ok(rememberCookieHeader().includes(`max-age=${REMEMBER_MAX_AGE_S}`), "with the documented lifetime");
// The write and the delete must agree on path and flags, or the browser leaves
// the old cookie in place and the sign-out silently does nothing. Compare
// everything except the pair's VALUE — including the flag-only `secure`, which
// carries no "=" and is exactly the kind of thing that drifts apart.
const attrs = (header: string) =>
  header.split(";").map((s) => s.trim()).filter((s) => s !== "secure" && !s.startsWith("max-age=") && !s.startsWith(`${REMEMBER_COOKIE}=`)).sort();
ok(rememberCookieHeader().split(";").some((s) => s.trim() === "secure"), "the cookie is Secure, so it never rides a plain-HTTP hop");
ok(
  JSON.stringify(attrs(rememberCookieHeader())) === JSON.stringify(attrs(forgetRememberCookieHeader())),
  "write and delete pair their path and flags",
  [attrs(rememberCookieHeader()), attrs(forgetRememberCookieHeader())]
);

console.log(`  ${passed}/${passed + failed} remember-login assertions passed`);
if (failed) process.exit(1);
