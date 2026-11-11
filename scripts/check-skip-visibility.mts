// Skip visibility: the policy the player renders and the skip route enforces.
//
// Two call sites read this module on purpose, so the guarantee that matters is
// agreement: a button shown but refused is a dead control in front of a
// listener, and that only shows up in production. So the truth table is
// asserted exhaustively rather than sampled, including the unknown-headcount
// case where the safe answer is to hide.
//
// Pure functions, no database, no request.
//
// Run: npm run check:skip-visibility
import type { SkipVisibility } from "../lib/skipvisibility.ts";
const sv = await import("../lib/skipvisibility.ts");

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

// ---- parsing: the stored value is free-form, so anything odd must land on solo ----
ok(sv.parseSkipVisibility("hidden") === "hidden", "hidden parses");
ok(sv.parseSkipVisibility("always") === "always", "always parses");
ok(sv.parseSkipVisibility("solo") === "solo", "solo parses");
ok(sv.SKIP_VISIBILITY_DEFAULT === "solo", "solo is the default");
for (const raw of [null, undefined, "", "  ", "SOLO", "Hidden", "yes", 0, 1, {}, [], true]) {
  ok(sv.parseSkipVisibility(raw) === "solo", `unrecognised ${JSON.stringify(raw) ?? String(raw)} falls back to solo`);
}

// ---- the whole truth table, no sampling ----
type Row = [SkipVisibility, number | null | undefined, boolean, string];
const table: Row[] = [
  ["hidden", 1, false, "hidden never offers the button"],
  ["hidden", 0, false, "hidden stays hidden when alone"],
  ["hidden", 99, false, "hidden stays hidden in a crowd"],
  ["hidden", null, false, "hidden stays hidden with an unknown headcount"],
  ["hidden", undefined, false, "hidden stays hidden with an undefined headcount"],

  ["always", 0, true, "always offers it to a lone listener"],
  ["always", 1, true, "always offers it to one listener"],
  ["always", 12, true, "always offers it to a crowd"],
  ["always", null, true, "always offers it even with an unknown headcount"],
  ["always", undefined, true, "always offers it even with an undefined headcount"],

  ["solo", 0, true, "solo offers it when nobody else is here"],
  ["solo", 1, true, "solo offers it when you are the one listener"],
  ["solo", 2, false, "solo withholds it from a pair"],
  ["solo", 50, false, "solo withholds it from a crowd"],
  // Fails closed: an unknown headcount must not render a button the server may refuse.
  ["solo", null, false, "solo withholds it when the headcount is unknown"],
  ["solo", undefined, false, "solo withholds it when the headcount is undefined"],
];
for (const [mode, listeners, expected, label] of table) {
  ok(sv.canSkipAsListener(mode, listeners) === expected, label);
}

// ---- a monotonic headcount, so the boundary is provably where it looks ----
for (let n = 0; n <= 5; n++) {
  ok(sv.canSkipAsListener("solo", n) === n <= 1, `solo agrees with "n <= 1" at ${n}`);
}

// ---- agreement with what the UI does ----
// The rule this enforces: hidden < solo < always, and no mode ever offers the
// button to a listener the policy hides it from.
for (const mode of ["hidden", "solo", "always"] as SkipVisibility[]) {
  const offers = [0, 1, 2, 3].map((n) => sv.canSkipAsListener(mode, n));
  if (mode === "hidden") ok(offers.every((o) => o === false), "hidden never offers at any headcount");
  if (mode === "always") ok(offers.every((o) => o === true), "always offers at every headcount");
  if (mode === "solo") ok(offers.join() === "true,true,false,false", "solo flips exactly at two listeners");
}
// Every value the UI offers must survive a parse round trip, or the select and
// the server could disagree about what was chosen.
for (const opt of sv.SKIP_VISIBILITY_OPTIONS) {
  ok(sv.parseSkipVisibility(opt.value) === opt.value, `option ${opt.value} round-trips through parse`);
  ok(!!opt.label && !!opt.blurb, `option ${opt.value} has a label and an explanation`);
}
ok(sv.SKIP_VISIBILITY_OPTIONS.length === 3, "all three modes are offered");
ok(sv.SKIP_VISIBILITY_OPTIONS.map((o) => o.value).sort().join() === "always,hidden,solo", "the option set is exactly the three modes");
// isAdmin is checked separately at both call sites, so the blurbs must not
// contradict that: none may claim admins lose Skip.
for (const opt of sv.SKIP_VISIBILITY_OPTIONS) {
  ok(!/admins? (?:never|do not|don't|cannot)/i.test(opt.blurb), `option ${opt.value} does not contradict the admin exception`);
}
ok(/admins? still do/i.test(sv.SKIP_VISIBILITY_OPTIONS.find((o) => o.value === "hidden")!.blurb), "the hidden option states admins keep the button");

console.log(`  ${passed}/${passed + failed} skip-visibility assertions passed`);
if (failed > 0) process.exit(1);
