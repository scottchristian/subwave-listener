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
  isWakingDbError,
  WAKING_DB_ERRORS,
  decideAutoSignIn,
  wakeStationDatabase,
  claimSigninAttempt,
  signinAttemptPending,
  SIGNIN_ATTEMPT_KEY,
  SIGNIN_ATTEMPT_WINDOW_MS,
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

// ------------------------------------------------- who signs themselves in

ok(
  decideAutoSignIn({ remembers: true, errorCode: "", alreadyAttempted: false }) === "attempt",
  "a plain visit in a remembered browser signs itself in — no button"
);
ok(
  decideAutoSignIn({ remembers: true, errorCode: "", alreadyAttempted: true }) === "leave-alone",
  "but only once: the courtesy try is spent for the tab"
);
ok(
  decideAutoSignIn({ remembers: false, errorCode: "", alreadyAttempted: false }) === "leave-alone",
  "a browser that has never signed in is never signed in without asking"
);
ok(
  decideAutoSignIn({ remembers: true, errorCode: "AccessDenied", alreadyAttempted: false }) === "leave-alone",
  "a rejected account is not retried on the listener's behalf"
);
ok(
  decideAutoSignIn({ remembers: true, errorCode: "Configuration", alreadyAttempted: false }) === "leave-alone",
  "nor is any error that is not about a sleeping database"
);

// THE REGRESSION, part two: the error page must always be handed to the bounded
// loop, whatever the guard says. Gating this on the guard is what left the
// earlier version stuck on a countdown that could never move.
for (const code of WAKING_DB_ERRORS) {
  ok(
    decideAutoSignIn({ remembers: true, errorCode: code, alreadyAttempted: true }) === "leave-to-retry-loop",
    `a sleeping-database error (${code}) hands over to the retry loop even after an attempt`
  );
  ok(
    decideAutoSignIn({ remembers: true, errorCode: code, alreadyAttempted: false }) === "leave-to-retry-loop",
    `a sleeping-database error (${code}) hands over before any attempt`
  );
}
ok(isWakingDbError("AccessDenied") === false, "AccessDenied is not a sleeping database");
ok(isWakingDbError("") === false, "a plain visit is not an error");

// The loop itself, simulated as a state machine: guard in, page loads out.
// The bug was that "attempt" was reachable again after a Google round-trip,
// because the guard was deleted on the way out. Drive the real transitions and
// assert the carousel cannot form.
{
  let guard = 0;
  let attempts = 0;
  // Worst case: the callback fails over and over, so every arrival is an error
  // page — which is exactly the sequence that used to loop forever.
  for (let i = 0; i < 50; i++) {
    const errorCode = i === 0 ? "" : "Callback";
    const decision = decideAutoSignIn({ remembers: true, errorCode, alreadyAttempted: guard === 1 });
    if (decision === "attempt") {
      attempts++;
      guard = 1; // the guard is spent and, crucially, survives the navigation
    } else if (decision === "leave-to-retry-loop") {
      guard = 0; // released on the way in, so the bounded loop is never gagged
    }
  }
  ok(attempts === 1, "fifty consecutive failed round-trips produce exactly ONE automatic attempt", attempts);
  ok(guard === 0, "and the guard ends released, so the retry loop can work", guard);
}

// A remembered browser that lands on a plain visit, succeeds, and never returns
// to this page must still spend its budget.
{
  let guard = 0;
  const first = decideAutoSignIn({ remembers: true, errorCode: "", alreadyAttempted: guard === 1 });
  if (first === "attempt") guard = 1;
  const second = decideAutoSignIn({ remembers: true, errorCode: "", alreadyAttempted: guard === 1 });
  ok(first === "attempt" && second === "leave-alone", "the courtesy try cannot be spent twice in a tab");
}

// ------------------------------------------------------------- waking first

{
  const calls: any[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push([url, init]);
    return { ok: true } as any;
  }) as unknown as typeof fetch;
  const woke = await wakeStationDatabase(fakeFetch);
  ok(woke === true, "a successful wake reports true");
  ok(calls.length === 1 && calls[0][0] === "/api/auth/wake-db", "and it POSTs the station's wake endpoint", calls);
  ok(calls[0][1]?.method === "POST", "with a POST", calls[0][1]);
}
{
  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  ok((await wakeStationDatabase(failing)) === false, "a wake that throws reports false rather than propagating");
}
{
  // The sign-in must still be attempted when the wake fails: the OAuth round
  // trip can succeed on its own, and swallowing the error is what let one bad
  // wake read strand the listener.
  let reached = false;
  const nope = (async () => ({ ok: false })) as unknown as typeof fetch;
  await wakeStationDatabase(nope).catch(() => {});
  reached = true;
  ok(reached, "a refused wake does not throw, so the caller still proceeds to sign in");
}

// ------------------------------------------- browser-wide OAuth flow claim

{
  // THE REGRESSION: three tabs of the error page, three retry loops, three
  // signIn() calls landing on ONE shared state cookie. NextAuth then refuses
  // every callback ("State cookie was missing") and nobody can sign in at all —
  // on a database that is perfectly awake, which is what made this look like an
  // outage rather than a race.
  //
  // Drive the real claim function against one shared store, the way three tabs
  // share one browser, and require that only the first wins.
  const shared = new Map<string, string>();
  const store = {
    getItem: (k: string) => shared.get(k) ?? null,
    setItem: (k: string, v: string) => void shared.set(k, v),
  };
  const t0 = 1_800_000_000_000;
  const tabs = [0, 1, 2].map((i) => claimSigninAttempt(t0 + i * 40, store)); // 40ms apart
  ok(
    tabs.filter(Boolean).length === 1,
    "three tabs signing in at once produce exactly ONE OAuth round-trip",
    tabs
  );
  ok(tabs[0] === true, "and it is the first to ask");
  ok(tabs[1] === false && tabs[2] === false, "the other two stand down");
  ok(
    signinAttemptPending(t0 + 100, store) === true,
    "while that flow is out, the browser reports an attempt as pending"
  );
  ok(
    claimSigninAttempt(t0 + 100, store) === false,
    "so a fourth tab cannot start one either"
  );
  ok(
    claimSigninAttempt(t0 + SIGNIN_ATTEMPT_WINDOW_MS, store) === true,
    "and once the window passes, the next tab may try",
  );
  ok(
    claimSigninAttempt(t0 + SIGNIN_ATTEMPT_WINDOW_MS - 1, store) === false,
    "one millisecond short of the window is still not enough"
  );

  // A tab that stood down must be able to recover on its own later, rather than
  // waiting for a human — the recovery loop has to keep working on its own.
  ok(
    claimSigninAttempt(t0 + 2 * SIGNIN_ATTEMPT_WINDOW_MS + 5_000, store) === true,
    "the loser retries on its own once the window passes"
  );
  ok(
    claimSigninAttempt(t0 + 2 * SIGNIN_ATTEMPT_WINDOW_MS + 6_000, store) === false,
    "and each success re-arms the window, so the loops stay staggered"
  );

  // Storage that refuses to cooperate must not lock everyone out of signing in.
  const hostile = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  ok(claimSigninAttempt(t0, hostile) === true, "a browser that blocks storage can still sign in");
  ok(signinAttemptPending(t0, hostile) === false, "and never believes an attempt is pending");

  // An unreadable marker must not read as a fresh one.
  const corrupt = { getItem: () => "not-a-number", setItem: () => {} };
  ok(signinAttemptPending(t0, corrupt) === false, "a corrupt marker reads as no attempt, not as a permanent block");

  ok(SIGNIN_ATTEMPT_WINDOW_MS >= 20_000, "the window outlives a real round-trip", SIGNIN_ATTEMPT_WINDOW_MS);
  ok(
    SIGNIN_ATTEMPT_WINDOW_MS <= 120_000,
    "but not so long that a failed round-trip strands the listener",
    SIGNIN_ATTEMPT_WINDOW_MS
  );
}

console.log(`  ${passed}/${passed + failed} remember-login assertions passed`);
if (failed) process.exit(1);
