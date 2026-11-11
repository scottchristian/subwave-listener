// The player must commit its data updates by calling setState and nothing else.
//
// This is NOT the check for the React #310 outage, and the header this file used
// to carry claimed it was. That claim was false, and it is worth being precise
// about why it was believed:
//
//   React #310 — "Rendered more hooks than during the previous render" — stopped
//   the player rendering for every signed-in listener, while signed-out visitors
//   and every incognito window were fine. The commit path below runs inside a
//   poll that only fires for an authenticated, approved session, so a pure
//   rendering fault presented exactly like an account fault. That asymmetry is
//   seductive, and three wrong fixes were deployed and reverted on the strength
//   of it (this one among them).
//
// The real cause was a `useMemo` added below Home's two early returns, so the two
// paths had different lengths. scripts/check-hooks-after-return.mts guards that,
// and found the real one the first time it ran.
//
// So these bans are kept on their own merits, not on a discredited theory:
//
//   flushSync renders synchronously from a callback React did not schedule, and
//   a hand-rolled document.startViewTransition puts a commit at a moment React
//   did not choose. Neither is worth a fade on a lineup that updates fine
//   without one, and both are easy to reach for by accident.
//
// The comment in app/page.tsx says all of this too, and says what the shape
// would have to look like if the transition ever comes back.
// Run: node scripts/check-commit-path.mts (wired as `npm run check:commit-path`).
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

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

const src = readFileSync(path.join(REPO, "app", "page.tsx"), "utf8");

// Read the CODE, not the prose. The comment explaining this bug necessarily names
// flushSync and startViewTransition, and a grep that matched comments would either
// fail forever or — worse — get "fixed" by deleting the explanation.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

// ------------------------------------------------------------ the three bans

ok(!/flushSync/.test(code), "no flushSync in the player's code");
ok(!/startViewTransition/.test(code), "no hand-rolled View Transition in the player's code");
ok(!/import\(\s*["']react-dom["']\s*\)/.test(code), "no dynamic react-dom import in the commit path");

// The same trap in a different costume: forcing a synchronous commit from a
// timer or a promise is the shape above, whatever it is called.
ok(!/reactDom\.flushSync|ReactDOM\.flushSync/.test(code), "and no aliased flushSync either");

// ------------------------------------------------------ the commit itself

const applyTriple = code.match(/const applyTriple = \(([\s\S]*?)\n {10}\};/);
ok(applyTriple !== null, "the commit path is findable");
const body = applyTriple ? applyTriple[1] : "";

// It must still apply the data — that is the whole point of the function.
ok(/setStationData\(/.test(body), "it still applies the lineup", body.slice(-90));
ok(/setScheduleData\(/.test(body), "still applies the schedule");
ok(/setAppStateData\(/.test(body), "still applies the app state");

// It must apply them whenever the payload is there, and each setter keeps its
// own truthiness guard so a failed fetch cannot blank the page — those guards
// are correct and are not what this is guarding against. What must not exist is
// a branch that skips the whole commit.
for (const setter of ["setStationData", "setScheduleData", "setAppStateData"]) {
  ok(
    new RegExp(`if \\(t\\.new\\w+\\) ${setter}\\(`).test(body),
    `${setter} is applied whenever its payload is present`
  );
}
const skip = body.match(/\b(if|else)\b[^{]*\{[^{}]*doApply\(\)/);
ok(skip === null, "and no branch wraps the commit itself", skip?.[0]);

// The animation is gone, so nothing about the commit depends on the browser
// having View Transitions, on visibility, or on anything but the data itself.
ok(!/document\.hidden/.test(body), "and it does not consult document.hidden");
ok(!/typeof document/.test(body), "nor sniff the environment");

// The commit is inside an async fetch, so it is called from outside React's
// scheduling by construction. That is fine — a plain setState from a timer is
// ordinary — and it is worth remembering that being outside React's scheduling
// is not the same as re-entering its renderer. flushSync crosses that line;
// setState does not.

// ------------------------------------------------- the reason stays written

// A comment that overstates its own cause is worse than no comment, so the two
// claims are pinned: that the reason is still written down, and that it does not
// quietly reinstate the theory this file was wrong about.
ok(/flushSync renders synchronously/.test(src), "and the reason it was removed is still written down");
ok(/decoration/.test(src), "including that it was decoration");
ok(
  /It was not the cause/.test(src),
  "and that it does not claim to have caused the outage — that is the part that was wrong before"
);

console.log(`  ${passed}/${passed + failed} commit-path assertions passed`);
if (failed) process.exit(1);
