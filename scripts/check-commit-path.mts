// The player must commit its data updates by calling setState and nothing else.
//
// This exists because of React #310 — "Rendered more hooks than during the
// previous render" — which stopped the player rendering at all, for every
// signed-in listener, while incognito and signed-out visitors were fine. Home
// committed its lineup behind
//
//   import("react-dom").then(() => document.startViewTransition(() => flushSync(doApply)))
//
// on every poll. flushSync renders synchronously from a promise callback React
// did not schedule, and calling document.startViewTransition by hand puts a
// commit at a moment React did not choose. Either re-enters the renderer
// mid-render and desynchronises the hook cursor, so the NEXT render throws on
// its first hook — useSession() in Home — naming nothing near the cause. The
// poll only runs for an authenticated, approved session, which is exactly why it
// looked like an account problem.
//
// So the rule is now simply "apply the update", and these assertions exist to
// make the interesting ways of not doing that impossible to reintroduce by
// accident.
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
// timer or a promise is the shape that caused this, whatever it is called.
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
// ordinary — but it is why every one of the bans above matters.

// ------------------------------------------------- the reason stays written

ok(/flushSync renders synchronously/.test(src), "and the reason it was removed is still written down");
ok(/decoration/.test(src), "including that it was decoration");

console.log(`  ${passed}/${passed + failed} commit-path assertions passed`);
if (failed) process.exit(1);
