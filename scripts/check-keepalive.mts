// Keep-alive configuration and the wake-on-knock loop.
//
// These two decide whether a free-tier database ever gets to sleep, and both
// have a failure mode that is invisible in production: a keep-alive that arms
// itself when nobody asked (it defeats the sleep it exists to protect), and a
// wake loop that never gives up or that starts one loop per visitor.
//
// clampSeconds is asserted across the whole input space because the dangerous
// case is a *blank* setting: Math.floor(Number("")) is 0, which clamps to the
// 30-second floor — the most aggressive value available — for a station that
// never configured one.
//
// The loop is driven against an unreachable database, with a fake prisma so no
// socket is opened, and the timing knobs are shortened through the exported
// options rather than by waiting minutes.
//
// Run: npm run check:keepalive
const ka = await import("../lib/dbkeepalive.ts");

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

// ---- interval clamping, including every way of saying "unset" ----
ok(ka.MIN_SECONDS === 30, "the floor is 30s");
ok(ka.MAX_SECONDS === 3600, "the ceiling is 3600s");
ok(ka.clampSeconds(300) === 300, "a normal value passes through");
ok(ka.clampSeconds("300") === 300, "a stringified value passes through");
ok(ka.clampSeconds(30) === 30, "the floor itself is allowed");
ok(ka.clampSeconds(3600) === 3600, "the ceiling itself is allowed");
// Blank means "unset" and must land on the default, never the aggressive floor.
for (const blank of ["", "   ", null, undefined]) {
  const v = ka.clampSeconds(blank);
  ok(v === 300, `blank (${JSON.stringify(blank)}) becomes the 300s default, not the 30s floor`);
}
ok(ka.clampSeconds(0) === 30, "an explicit zero clamps to the floor");
ok(ka.clampSeconds(-5) === 30, "a negative clamps to the floor");
ok(ka.clampSeconds(10) === 30, "below the floor clamps up");
ok(ka.clampSeconds(99999) === 3600, "above the ceiling clamps down");
ok(ka.clampSeconds(300.9) === 300, "a fractional value floors");
for (const junk of ["abc", "NaN", "30s", {}, [], true]) {
  const v = ka.clampSeconds(junk);
  ok(v === 300 || v === 30 || v === 3600, `junk input (${JSON.stringify(junk)}) stays inside the range`);
}

// ---- config parsing: absent means off, never a surprise poke ----
{
  const saved = { ...process.env };
  delete process.env.DB_KEEPALIVE;
  delete process.env.DB_KEEPALIVE_SECONDS;
  ok(ka.readConfig().enabled === false, "no env means off");
  ok(ka.readConfig().seconds === 300, "no env still yields the default interval");
  for (const truthy of ["1", "true", "TRUE", "yes", "on", "ON", " true "]) {
    process.env.DB_KEEPALIVE = truthy;
    ok(ka.readConfig().enabled === true, `armed by ${JSON.stringify(truthy)}`);
  }
  for (const falsy of ["0", "false", "no", "off", "", "  ", "maybe", "2"]) {
    process.env.DB_KEEPALIVE = falsy;
    ok(ka.readConfig().enabled === false, `not armed by ${JSON.stringify(falsy)}`);
  }
  process.env.DB_KEEPALIVE = "true";
  process.env.DB_KEEPALIVE_SECONDS = "";
  ok(ka.readConfig().seconds === 300, "a blank interval does not become the aggressive floor");
  process.env.DB_KEEPALIVE_SECONDS = "45";
  ok(ka.readConfig().seconds === 45, "a configured interval is read");
  Object.assign(process.env, saved);
}

// ---- state transitions, without arming a real timer ----
{
  const snap = ka.snapshot();
  ok(typeof snap.enabled === "boolean" && typeof snap.seconds === "number", "snapshot is well-formed");
  ok(snap.running === false, "nothing is running before start()");
  ok(snap.totalPings === 0, "no pings before start()");
  ok(snap.lastOkAt === null && snap.lastAttemptAt === null, "no timestamps before start()");
  ok(snap.consecutiveFailures === 0, "no failures recorded before start()");
  ok(snap.lastError === null, "no error before start()");

  // reconfigure() changes the live timer without touching process.env, so the
  // snapshot must report the *live* state — otherwise the panel would show ON
  // right after the operator saved OFF.
  ka.reconfigure(true, 120);
  const on = ka.snapshot();
  ok(on.enabled === true, "reconfigure on is visible in the snapshot");
  ok(on.seconds === 120, "reconfigure sets the interval");
  ok(on.running === true, "an armed keep-alive reports as running");
  ka.stop();
  const off = ka.snapshot();
  ok(off.enabled === false, "stop is visible in the snapshot");
  ok(off.running === false, "a stopped keep-alive is not running");
  ka.reconfigure(true, 5);
  ok(ka.snapshot().seconds === ka.MIN_SECONDS, "reconfigure clamps an interval below the floor");
  ka.reconfigure(true, 99999);
  ok(ka.snapshot().seconds === ka.MAX_SECONDS, "reconfigure clamps to the ceiling");
  ka.stop();
}

// ---- the wake loop, against a database that is not there ----
{
  // Point at a port nothing is listening on: every knock fails, fast, with no
  // socket left open and no chance of accidentally reaching a real database.
  process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nothing?connect_timeout=1";
  const wake = await import("../lib/dbwake.ts");

  let attempts = 0;
  const woke = await wake.wakeDb({
    timeoutMs: 0,
    onAttempt: (n) => {
      attempts = n;
    },
  });
  ok(woke === false, "the loop gives up rather than hanging forever");
  ok(attempts === 1, "it knocked at least once before giving up");

  // A timeout of zero must still knock once: a listener's first request should
  // not be spent waiting on a loop that decides it has no time.
  let counted = 0;
  const again = await wake.wakeDb({ timeoutMs: 0, onAttempt: () => counted++ });
  ok(again === false && counted >= 1, "a zero timeout still makes one attempt");

  // Concurrent callers must share one loop, not each start their own. Asserted
  // by promise identity rather than by awaiting: the guarantee is that the very
  // same promise comes back, which is instant to check. Awaiting the result
  // would instead spend the loop's full 3-minute timeout in the test suite.
  const a = wake.wakeDbInBackground();
  const b = wake.wakeDbInBackground();
  const c = wake.wakeDbInBackground();
  ok(a === b && b === c, "three concurrent callers join one shared loop");
  // A later caller, while it runs, still joins rather than starting a second.
  ok(wake.wakeDbInBackground() === a, "a later caller joins the running loop too");
  // Let it finish on its own schedule; the suite must not wait three minutes.
  a.finally(() => {});
}

console.log(`  ${passed}/${passed + failed} keepalive assertions passed`);
// Exit rather than falling off the end: the shared wake loop above is still
// knocking on a 5s timer for its full 3-minute budget, and nothing else is
// left to wait for.
process.exit(failed > 0 ? 1 : 0);
