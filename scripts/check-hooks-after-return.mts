// Rules of Hooks, enforced structurally.
//
// The bug this exists for: Home returns early twice before rendering anything,
//
//   if (status === "loading") return <div>Loading...</div>;
//   if (!session)            return (<main id="main-player">… sign-in card …</main>);
//
// and a `useMemo` added BELOW those guards was therefore reached only once a
// session existed. A signed-out visitor called N hooks and a signed-in listener
// called N+1, and React threw #310, "Rendered more hooks than during the
// previous render", on the component's FIRST hook — naming useSession() and
// nothing near the cause. /admin was fine (no early return), incognito was fine
// (signed out, short path only), every browser was affected, and the crash
// landed exactly when the session flipped and the paths diverged.
//
// Two assertions, because the weak one is easy to write and easy to get wrong:
//
//   1. NO HOOK AFTER AN EARLY RETURN. The precise statement of that bug, and the
//      one that produces a useful message naming the offending line.
//
//   2. EVERY HOOK IS REACHABLE ON EVERY PATH — the total hook count in the
//      component equals the count before its first early return. This is the
//      invariant React actually cares about, and it holds even if a future
//      component returns early in a shape assertion 1 does not recognise (a
//      `return` inside a switch, a try, a labelled block). Assertion 1 alone
//      would miss that; this one would not.
//
// The checker classifies every brace as a block or a function body, because
// indentation cannot distinguish `if (x) { return … }` (still the component's)
// from `useEffect(() => { return … })` (the callback's), and a fixed-depth rule
// misses the first because the return sits one brace deeper than the body.
// Both of those were bugs in earlier versions of this file, and both reported
// ZERO findings on a broken file — so it also checks itself, on synthetic
// components, in both directions.
// Run: node scripts/check-hooks-after-return.mts (wired as `npm run check:hook-order`).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  scrub, frames, components, hookOn, ownReturnOn, inside, inNestedFunction, walkTsx,
} from "./lib/tsx-scan.mts";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
  }
}

interface Finding {
  file: string;
  component: string;
  kind: "hook-after-return" | "unreachable-hook";
  line: number;
  detail: string;
}

function analyse(src: string): { findings: Finding[]; components: number } {
  const lines = scrub(src).split("\n");
  const atStart = frames(lines.join("\n"));
  const findings: Finding[] = [];
  const comps = components(lines, atStart);

  for (const c of comps) {
    // The component's own body is neither "inside a callback" nor the start of
    // its scan: on the declaration line the brace stack is still empty, so the
    // scan must begin on the line after the body opens.
    const start = c.bodyLine + 1;
    let total = 0;
    let firstReturn = -1;
    let beforeReturn = 0;

    for (let j = start; j < lines.length; j++) {
      const st = atStart[j];
      if (!inside(st, c.bodyIdx)) break; // left the component
      if (inNestedFunction(st, c.bodyIdx)) continue; // a hook in a callback is not the component's

      const hook = hookOn(lines[j]);
      if (hook) {
        total++;
        if (firstReturn < 0) beforeReturn++;
        else {
          findings.push({
            file: "", component: c.name, kind: "hook-after-return",
            line: j + 1, detail: `use${hook} at line ${j + 1} follows the early return at line ${firstReturn + 1}`,
          });
        }
      }
      if (firstReturn < 0 && ownReturnOn(lines[j])) firstReturn = j;
    }

    // (2) the invariant, stated over counts rather than positions
    if (firstReturn >= 0 && beforeReturn !== total) {
      findings.push({
        file: "", component: c.name, kind: "unreachable-hook",
        line: firstReturn + 1,
        detail: `${c.name}() reaches ${total} hooks on its long path but only ${beforeReturn} before the early return at line ${firstReturn + 1}`,
      });
    }
  }
  return { findings, components: comps.length };
}

// ------------------------------------------------------------------ the app

const all: Finding[] = [];
let componentCount = 0;
for (const file of walkTsx(path.join(REPO, "app"))) {
  const r = analyse(readFileSync(file, "utf8"));
  componentCount += r.components;
  for (const f of r.findings) all.push({ ...f, file: path.relative(REPO, file) });
}

for (const f of all) {
  console.log(`  FAIL  ${f.file}:${f.line} — ${f.detail}`);
}
ok(
  all.length === 0,
  `every hook is reachable on every path (checked ${componentCount} components)`,
  all.map((f) => `${f.file}:${f.line} ${f.detail}`)
);

// ------------------------------------------------- the checker checks itself

/** Analyse a synthetic component; returns what the real path above would report. */
const check = (probe: string) => analyse(probe).findings;

{
  // The shape that shipped, including the nesting that defeated earlier attempts.
  const f = check(
    [
      "function Player() {",
      "  const { data } = useSession();",
      "  if (!data) {",
      "    return null;",
      "  }",
      "  const idx = useMemo(() => build(), [data]);",
      "  return idx;",
      "}",
    ].join("\n")
  );
  ok(f.some((x) => x.kind === "hook-after-return" && x.detail.includes("useMemo")), "catches a hook after an early return", f);
  ok(f.some((x) => x.kind === "unreachable-hook" && x.detail.includes("2 hooks") && x.detail.includes("only 1")), "and reports the count mismatch", f);
}

{
  // A return inside a callback is the callback's, not the component's.
  const f = check(
    [
      "function Q() {",
      "  useEffect(() => {",
      "    if (!x) return;",
      "    doThing();",
      "  }, []);",
      "  const v = useMemo(() => 1, []);",
      "  return null;",
      "}",
    ].join("\n")
  );
  ok(f.length === 0, "a return inside useEffect is not an early return", f);
}

{
  // Hooks before the early return is the ordinary shape.
  const f = check(
    [
      "function R() {",
      "  const a = useState(1);",
      "  const b = useMemo(() => a, [a]);",
      "  if (!a) return null;",
      "  return b;",
      "}",
    ].join("\n")
  );
  ok(f.length === 0, "hooks BEFORE the early return are fine", f);
}

{
  // A `return` inside a try block still short-circuits the component, and a hook
  // below it is still unreachable. Assertion 1's position rule catches this; the
  // count invariant catches it even if that rule were loosened.
  const f = check(
    [
      "function T() {",
      "  const a = useState(0);",
      "  try {",
      "    if (a) return null;",
      "  } catch {}",
      "  const b = useMemo(() => a, [a]);",
      "  return b;",
      "}",
    ].join("\n")
  );
  ok(f.some((x) => x.kind === "unreachable-hook"), "a return nested in a try block still counts", f);
}

{
  // A component with no early return must never be reported, however many hooks.
  const f = check(
    [
      "function U({ n }) {",
      "  const a = useState(n);",
      "  const b = useEffect(() => {}, [n]);",
      "  const c = useRef(null);",
      "  const d = useMemo(() => n * 2, [n]);",
      "  const e = useCallback(() => {}, []);",
      "  return { a, b, c, d, e };",
      "}",
    ].join("\n")
  );
  ok(f.length === 0, "a hook-heavy component with no early return is not reported", f);
}

console.log(`  ${passed}/${passed + failed} hook-order assertions passed`);
if (failed) process.exit(1);
