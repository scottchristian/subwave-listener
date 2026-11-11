// "Are you still listening?" timer math. Pure lib, no fixtures: the clock is
// driven by hand. Run: node scripts/check-still-listening.mts
// (wired as `npm run check:still-listening`).
import {
  parseStillListening,
  validateStillListening,
  stopAtFrom,
  extendStop,
  stillListeningPhase,
  STILL_LISTENING_DEFAULTS,
} from "../lib/still-listening.ts";

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

const MIN = 60 * 1000;
// The operator's example: 9:00 start, 60-minute window, 10-minute reminder.
const start9 = Date.UTC(2026, 9, 5, 9, 0, 0);
const stop10 = stopAtFrom(start9, 60);
ok(stop10 === Date.UTC(2026, 9, 5, 10, 0, 0), "9:00 + 60min stops at 10:00");
const reminderMs = 10 * MIN;
ok(stillListeningPhase(Date.UTC(2026, 9, 5, 9, 49, 59), stop10, reminderMs) === "listening", "9:49:59 still listening");
ok(stillListeningPhase(Date.UTC(2026, 9, 5, 9, 50, 0), stop10, reminderMs) === "remind", "9:50 reminder fires");
ok(stillListeningPhase(Date.UTC(2026, 9, 5, 9, 59, 59), stop10, reminderMs) === "remind", "9:59 still reminding");
ok(stillListeningPhase(Date.UTC(2026, 9, 5, 10, 0, 0), stop10, reminderMs) === "stop", "10:00 stops");
// Confirm at 9:50 pushes the STOP out a full window: 11:00, not 10:50.
const stop11 = extendStop(stop10, 60);
ok(stop11 === Date.UTC(2026, 9, 5, 11, 0, 0), "confirm extends stop to 11:00");
ok(stillListeningPhase(Date.UTC(2026, 9, 5, 10, 50, 0), stop11, reminderMs) === "remind", "second reminder at 10:50");
// Confirming twice stacks whole windows.
ok(extendStop(stop11, 60) === Date.UTC(2026, 9, 5, 12, 0, 0), "second confirm reaches 12:00");

// Parsing: absent means off with defaults; garbage clamps, never explodes.
const d = parseStillListening({});
ok(d.enabled === false && d.minutes === 60 && d.reminderMinutes === 10, "defaults when unset");
ok(parseStillListening({ enabled: "true", minutes: "60", reminderMinutes: "10" }).enabled === true, "enabled parses");
const cl = parseStillListening({ enabled: "true", minutes: "5", reminderMinutes: "30" });
ok(cl.minutes === 5 && cl.reminderMinutes === 4, "reminder clamps below the window");
ok(parseStillListening({ enabled: "true", minutes: "9999", reminderMinutes: "x" }).minutes === 720, "window clamps to max");
ok(STILL_LISTENING_DEFAULTS.minutes === 60, "default window 60");

// Validation: specific rejections for the admin form.
ok(validateStillListening("60", "10").ok === true, "60/10 valid");
ok(validateStillListening("60", "60").ok === false, "reminder equal to window rejected");
ok(validateStillListening("60", "90").ok === false, "reminder beyond window rejected");
ok(validateStillListening("3", "1").ok === false, "window below minimum rejected");
ok(validateStillListening("abc", "10").ok === false, "non-numeric window rejected");

console.log(`  ${passed}/${passed + failed} still-listening assertions passed`);
if (failed > 0) process.exit(1);
