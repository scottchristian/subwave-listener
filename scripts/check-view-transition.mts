// How the player commits a data update, and specifically what it must never do
// again.
//
// This exists because of React #310 — "Rendered more hooks than during the
// previous render" — which took the whole player down for signed-in listeners.
// Home committed its lineup inside
//
//   import("react-dom").then(() => document.startViewTransition(() => flushSync(doApply)))
//
// on every poll. flushSync renders synchronously; calling it from a promise
// callback React did not schedule re-enters the renderer mid-render and
// desynchronises the hook cursor, so the NEXT render throws on its first hook.
// The stack pointed at useSession() in Home and named nothing else, and because
// the poll returns early for anyone not signed in and approved, only signed-in
// listeners ever crashed — incognito worked every time.
//
// So these assertions pin the two rules that fix it, and the one structural
// check that keeps the old code from coming back.
// Run: node scripts/check-view-transition.mts (wired as `npm run check:view-transition`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { newGate, shouldAnimateCommit, beginCommit, endCommit } from "../lib/view-transition.ts";

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

// ---------------------------------------------------------------- the gate

{
  const gate = newGate();
  ok(shouldAnimateCommit({ animate: true, hidden: false, supported: true, gate }), "a visible change animates when the browser can");
  ok(!shouldAnimateCommit({ animate: false, hidden: false, supported: true, gate }), "an identical re-poll never animates — no white flash for nothing");
  ok(!shouldAnimateCommit({ animate: true, hidden: true, supported: true, gate }), "a hidden tab never animates (the call throws there)");
  ok(!shouldAnimateCommit({ animate: true, hidden: false, supported: false, gate }), "a browser without View Transitions never animates");
}

// ------------------------------------------------- one transition at a time

{
  // THE REGRESSION, part two: nothing stopped the 5s poll and the promotion
  // timer from both starting a transition, which is invalid and left React's
  // state inconsistent.
  const gate = newGate();
  ok(beginCommit(gate) === true, "the first commit takes the transition slot");
  ok(beginCommit(gate) === false, "a second commit while it runs is refused");
  ok(
    !shouldAnimateCommit({ animate: true, hidden: false, supported: true, gate }),
    "so the overlapping commit applies directly instead of nesting"
  );
  ok(gate.inFlight === true, "the slot is held until it settles");

  endCommit(gate);
  ok(gate.inFlight === false, "settling releases it");
  ok(beginCommit(gate) === true, "and the next commit animates again");

  // A transition that rejects must not wedge the slot for the rest of the
  // session — the page would otherwise silently stop animating for good.
  const g2 = newGate();
  beginCommit(g2);
  endCommit(g2);
  endCommit(g2);
  ok(g2.inFlight === false, "releasing twice is harmless");
  ok(shouldAnimateCommit({ animate: true, hidden: false, supported: true, gate: g2 }), "so a rejected transition cannot wedge it");
}

// ------------------------------------- the old code must not come back

{
  // Read the CODE, not the prose. The comment explaining this bug necessarily
  // names flushSync and the dynamic import, and a grep that matched comments
  // would either fail forever or — worse — get deleted to make it pass, taking
  // the explanation with it.
  const src = readFileSync(path.join(REPO, "app", "page.tsx"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  // The one that broke it.
  ok(!/flushSync/.test(code), "no flushSync anywhere in the player's code");
  // The thing that put it at a moment React had not chosen.
  ok(!/import\(\s*["']react-dom["']\s*\)/.test(code), "no dynamic react-dom import in the commit path");
  ok(!/startViewTransition\([\s\S]{0,200}flushSync/.test(code), "and no transition callback reaches for a forced sync render");

  // The gate has to be consulted, not merely defined.
  ok(/shouldAnimateCommit\(/.test(code), "the commit path consults the gate");
  ok(/beginCommit\(/.test(code) && /endCommit\(/.test(code), "and claims and releases the single slot");

  // A transition callback that does not apply the update would animate nothing.
  const vt = code.match(/startViewTransition\(\(\)\s*=>\s*\{([\s\S]{0,200}?)\}\)/);
  ok(vt !== null, "there is a startViewTransition callback");
  ok(vt !== null && /doApply\(\)/.test(vt[1]), "and it applies the update itself", vt?.[1]);

  // The explanation is worth keeping, so assert it is there rather than gone.
  ok(/NO flushSync/.test(src), "and the reason it was removed is still written down");
}

console.log(`  ${passed}/${passed + failed} view-transition assertions passed`);
if (failed) process.exit(1);
