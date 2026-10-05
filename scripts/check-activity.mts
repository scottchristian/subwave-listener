// Activity gate: anyoneActive() answers "is someone here?" for every
// background database loop, from process memory — asking the database would
// keep it awake, which is what this gate exists to prevent.
//
// Pure functions of time, so no database, no client, no fixtures: the clock
// is driven by hand. Run: node scripts/check-activity.mts
// (wired as `npm run check:activity`).
import { anyoneActive, noteActivity, ACTIVE_WINDOW_MS } from "../lib/activity.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const T0 = 1_800_000_000_000; // fixed point, no wall-clock flake
ok(ACTIVE_WINDOW_MS === 2 * 60 * 1000, "window matches the presence route (2 min)");

// Fresh boot knows nobody.
ok(anyoneActive(T0) === false, "no stamp -> inactive");

// A heartbeat means someone here.
noteActivity(T0);
ok(anyoneActive(T0) === true, "fresh stamp -> active");
ok(anyoneActive(T0 + 60 * 1000) === true, "1-minute stamp -> active");

// Aged out: gone.
ok(anyoneActive(T0 + 3 * 60 * 1000) === false, "3-minute stamp -> inactive");

// A new heartbeat re-arms after silence.
noteActivity(T0 + 10 * 60 * 1000);
ok(anyoneActive(T0 + 10 * 60 * 1000) === true, "re-stamp after silence -> active");

// Backdated stamps never count.
noteActivity(T0 - 10 * 60 * 1000);
ok(anyoneActive(T0) === false, "old stamp -> inactive");

console.log(`  ${passed}/${passed + failed} activity assertions passed`);
if (failed > 0) process.exit(1);
