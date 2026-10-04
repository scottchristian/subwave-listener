// Automatic-update scheduler tests: window math, timezone handling and the
// tick decision matrix. All pure — no database, no network, no pm2. The tick
// itself (which wires these to GitHub and the pipeline) is exercised against a
// scratch station by hand, not here.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = process.env.DATABASE_URL || "file:/tmp/auto-update-test-unused.db";

const auto = await import("../lib/auto-update.ts");

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

// ---- time parsing: what the <input type="time"> sends ----
const times: Array<[unknown, string | null, string]> = [
  ["02:00", "02:00", "padded"],
  ["2:00", "02:00", "single-digit hour normalized"],
  ["23:59", "23:59", "end of day"],
  ["00:00", "00:00", "midnight"],
  [" 03:30 ", "03:30", "whitespace trimmed"],
  ["24:00", null, "hour 24 rejected"],
  ["02:60", null, "minute 60 rejected"],
  ["2:5", null, "single-digit minute rejected"],
  ["", null, "empty rejected"],
  ["abc", null, "garbage rejected"],
  [null, null, "null rejected"],
  ["02:00:00", null, "seconds rejected"],
];
for (const [raw, want, why] of times) {
  ok(auto.parseTimeOfDay(raw) === want, `parse ${JSON.stringify(raw)} (${why})`);
}

// ---- timezone math on fixed instants (runner-TZ independent) ----
{
  // 2026-07-01T00:00Z: July is AEST (+10) in Hobart.
  const winter = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
  ok(auto.minutesInZone(winter, "UTC") === 0, "UTC midnight");
  ok(auto.minutesInZone(winter, "Australia/Hobart") === 600, "Hobart winter +10");
  // 2026-12-01T00:00Z: December is AEDT (+11). (Early October is still AEST —
  // Tasmanian DST starts the first Sunday in October — so pin summer to December.)
  const summer = new Date(Date.UTC(2026, 11, 1, 0, 0, 0));
  ok(auto.minutesInZone(summer, "Australia/Hobart") === 660, "Hobart summer +11");
  ok(auto.minutesInZone(summer, "America/New_York") === 1140, "New York previous evening (19:00)");
  ok(auto.minutesInZone(summer, "Not/AZone") === null, "unknown zone is null, not a throw");
}

// ---- window membership, including overnight wrap ----
{
  const W = auto.isInWindow;
  ok(W(120, 120, 240) === true, "inclusive start");
  ok(W(239, 120, 240) === true, "inside");
  ok(W(240, 120, 240) === false, "exclusive end");
  ok(W(119, 120, 240) === false, "before");
  ok(W(1320, 1320, 240) === true, "overnight: at start");
  ok(W(1380, 1320, 240) === true, "overnight: late evening");
  ok(W(0, 1320, 240) === true, "overnight: after midnight");
  ok(W(239, 1320, 240) === true, "overnight: just before end");
  ok(W(240, 1320, 240) === false, "overnight: end exclusive");
  ok(W(720, 1320, 240) === false, "overnight: midday out");
  ok(W(720, 720, 720) === false, "zero-length window never opens");
}

// ---- the tick decision matrix ----
{
  const base = {
    settings: { enabled: true, start: "02:00", end: "04:00" },
    timeZone: "UTC",
    serverNow: new Date(Date.UTC(2026, 0, 1, 3, 0, 0)),
    updateAvailable: true,
    latestLabel: "0.0.3",
    channel: "release" as const,
    listeners: 0,
    job: null,
  };
  const dec = (over: object) => auto.decideAutoTick({ ...base, ...over });
  ok(dec({}).start === true, "quiet in-window with update starts");
  ok(dec({ settings: { enabled: false, start: "02:00", end: "04:00" } }).start === false, "disabled never starts");
  ok(dec({ settings: { enabled: true, start: "", end: "" } }).start === false, "incomplete window never starts");
  ok(dec({ settings: { enabled: true, start: "02:00", end: "02:00" } }).start === false, "zero window never starts");
  ok(
    dec({ serverNow: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)) }).start === false,
    "outside window waits"
  );
  ok(dec({ updateAvailable: false }).start === false, "nothing new waits");
  ok(dec({ listeners: 1 }).start === false, "one listener waits");
  ok(dec({ listeners: null }).start === false, "unreadable room waits (fail closed)");
  ok(
    dec({ job: { status: "running", updatedAt: new Date().toISOString() } as any }).start === false,
    "running job blocks"
  );
  ok(
    dec({ job: { status: "failed", updatedAt: new Date().toISOString() } as any }).start === false,
    "fresh failure suppresses retry"
  );
  ok(
    dec({
      job: { status: "failed", updatedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() } as any,
    }).start === true,
    "day-old failure retries"
  );
  ok(
    dec({ job: { status: "done", updatedAt: new Date().toISOString() } as any }).start === true,
    "finished job does not block (availability decides)"
  );
  // Overnight window with a zone: 13:00 UTC is midnight in Hobart winter... use an
  // explicit case: 16:30 UTC in July = 02:30 Hobart = inside 02:00–04:00.
  ok(
    dec({
      timeZone: "Australia/Hobart",
      serverNow: new Date(Date.UTC(2026, 6, 1, 16, 30, 0)),
    }).start === true,
    "window evaluated in station time, not server time"
  );
  ok(
    dec({
      timeZone: "Australia/Hobart",
      serverNow: new Date(Date.UTC(2026, 6, 1, 16, 30, 0)),
      settings: { enabled: true, start: "03:00", end: "04:00" },
    }).start === false,
    "station-time miss waits"
  );
  // Reason strings exist for every no-start (operators read these in logs).
  const quiet = dec({ listeners: 2 });
  ok(quiet.start === false && quiet.reason.includes("2 listener"), "refusal names the count");
}

console.log(`  ${passed}/${passed + failed} auto-update assertions passed`);
if (failed) process.exitCode = 1;
