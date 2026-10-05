// Schedule day-run grouping: identical consecutive lineups merge so the
// browser reads "Monday → Thursday" and jumps run to run.
// Run: node scripts/check-schedule-run.mts (wired as `npm run check:schedule-run`).
import { runForDay } from "../lib/schedule-run.ts";

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

// Mon–Thu share lineup A; Fri, Sat, Sun each differ. (0=Sun..6=Sat)
const sigs: Record<number, string> = { 0: "E", 1: "A", 2: "A", 3: "A", 4: "A", 5: "B", 6: "C" };
const sig = (d: number) => sigs[((d % 7) + 7) % 7];

let r = runForDay(sig, 2); // Tuesday
ok(r.start === 1 && r.end === 4, "Tue sits in Mon–Thu run", ` got ${r.start}..${r.end}`);
r = runForDay(sig, 1); // Monday (run edge)
ok(r.start === 1 && r.end === 4, "Mon run covers Mon–Thu", ` got ${r.start}..${r.end}`);
r = runForDay(sig, 4); // Thursday (run edge)
ok(r.start === 1 && r.end === 4, "Thu run covers Mon–Thu", ` got ${r.start}..${r.end}`);
r = runForDay(sig, 5); // Friday
ok(r.start === 5 && r.end === 5, "Fri stands alone", ` got ${r.start}..${r.end}`);
r = runForDay(sig, 0); // Sunday
ok(r.start === 0 && r.end === 0, "Sun stands alone", ` got ${r.start}..${r.end}`);

// Wrap: Sun+Mon share a lineup.
const sig2 = (d: number) => ({ 0: "W", 1: "W", 2: "X", 3: "X", 4: "Y", 5: "Y", 6: "Z" }[((d % 7) + 7) % 7] as string);
r = runForDay(sig2, 1); // Monday
ok(r.start === 0 && r.end === 1, "Mon run reaches back into Sun", ` got ${r.start}..${r.end}`);
r = runForDay(sig2, 0); // Sunday
ok(r.start === 0 && r.end === 1, "Sun run reaches forward into Mon", ` got ${r.start}..${r.end}`);

// Uniform week: one run, never more than 7.
const sig3 = () => "SAME";
r = runForDay(sig3, 3);
ok(r.end - r.start === 6, "uniform week is a single 7-day run", ` got span ${r.end - r.start}`);

// Alternating: every day alone.
const sig4 = (d: number) => ((((d % 7) + 7) % 7) % 2 === 0 ? "E" : "O");
r = runForDay(sig4, 2);
ok(r.start === 2 && r.end === 2, "alternating days stand alone", ` got ${r.start}..${r.end}`);

// Run always contains the viewed day.
for (let d = 0; d < 7; d++) {
  const q = runForDay(sig, d);
  if (!(q.start <= d && d <= q.end && q.end - q.start <= 6)) {
    ok(false, `run contains viewed day ${d}`, ` got ${q.start}..${q.end}`);
  }
}
ok(true, "run contains viewed day for all 7");

console.log(`  ${passed}/${passed + failed} schedule-run assertions passed`);
if (failed > 0) process.exit(1);
