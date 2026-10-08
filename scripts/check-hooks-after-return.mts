// No hook may be called after an early return in a component.
//
// This is the rule whose absence took the player down for every signed-in
// listener. Home returns early twice before it renders anything:
//
//   if (status === "loading") return <div>Loading...</div>;
//   if (!session)            return (<main id="main-player">… sign-in card …</main>);
//
// A `useMemo` added below those guards — to index the schedule's personas for
// the host card — is only reached once a session exists. So a signed-out visitor
// called N hooks and a signed-in one called N+1, and React threw #310, "Rendered
// more hooks than during the previous render", on the component's FIRST hook.
// The stack named useSession() in Home and nothing near the cause. /admin was
// fine. Incognito was fine. It reproduced in Chrome and Safari alike.
//
// It is a structural rule, so it is checked structurally: a `return` belongs to
// the component when nothing FUNCTION-shaped encloses it — being inside an `if`
// is still the component's own return, being inside a callback is not.
//
// Two earlier attempts at this check failed to see the bug, both by comparing
// indentation: the `return` sat four spaces in and the hook two, so a
// same-indent rule never matched them, and a fixed-depth rule missed it because
// `if (…) { return … }` sits one brace deeper than the body. Hence classifying
// every brace as a block or a function body.
// Run: node scripts/check-hooks-after-return.mts (wired as `npm run check:hook-order`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const APP = path.join(REPO, "app");

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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Remove comments and string bodies so braces inside them cannot be counted. */
function scrub(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      let inS = false;
      let inT = false;
      let cut = -1;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "\\") { i++; continue; }
        if (!inT && c === '"') inS = !inS;
        else if (!inS && c === "'") inT = !inT;
        else if (!inS && !inT && c === "/" && line[i + 1] === "/") { cut = i; break; }
      }
      const body = cut === -1 ? line : line.slice(0, cut);
      return body.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    })
    .join("\n");
}

const HOOK =
  /(?:^|[^A-Za-z0-9_$])(?:React\.)?use(State|Effect|Ref|Memo|Callback|Reducer|Context|LayoutEffect|ImperativeHandle|DebugValue|Optimistic|ActionState|Transition|DeferredValue|SyncExternalStore|Id)\s*\(/;
const COMPONENT = /^(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/;

/** Keywords that take a parenthesised head but are NOT function bodies. */
const CONTROL = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "try", "with",
  "return", "typeof", "await", "new", "delete", "in", "of", "case",
]);

/**
 * Is the `{` at the end of `before` opening a function body rather than a block?
 *
 * `if (x) {` must NOT match, and neither must `switch (x) {` or `catch (e) {` —
 * all three take a parenthesised head and all three are blocks. A method
 * shorthand `onHost() {` and an IIFE `(function () {` must match. Getting this
 * wrong in EITHER direction silently hides or invents findings, which is how
 * the first two versions of this check passed a file that was broken.
 */
export function isFunctionHead(before: string): boolean {
  const t = before.replace(/\s+$/, "");
  if (/=>$/.test(t)) return true;
  if (/\b(?:async\s+)?function\b(?:\s+[A-Za-z0-9_$]+)?\s*(?:\([^)]*\))?$/.test(t)) return true;
  const call = t.match(/([A-Za-z0-9_$]+)\s*(?:\([^()]*\))?$/);
  if (call) return !CONTROL.has(call[1]);
  return false;
}

interface Frame {
  fn: boolean;
  line: number;
}

/** Brace stack at the start of each line, each frame tagged with its opener's line. */
export function frames(src: string): Frame[][] {
  const lines = src.split("\n");
  const stack: Frame[] = [];
  const atStart: Frame[][] = [];
  for (let i = 0; i < lines.length; i++) {
    atStart.push([...stack]);
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === "{") stack.push({ fn: isFunctionHead(line.slice(0, c)), line: i });
      else if (ch === "}") stack.pop();
    }
  }
  return atStart;
}

/**
 * Is line `j` still inside this component?
 *
 * `bodyIdx` is the index of the component's OWN body frame, so being deeper than
 * that is the test — and a frame strictly deeper than it being a FUNCTION frame
 * is what makes a `return` belong to a callback rather than the component. The
 * component's own body counts as neither: it is a function frame, but it is this
 * component, so `slice(bodyIdx + 1)` and not `slice(bodyIdx)`.
 */
function inside(st: Frame[], bodyIdx: number): boolean {
  return st.length > bodyIdx;
}
function nestedFunction(st: Frame[], bodyIdx: number): boolean {
  return st.slice(bodyIdx + 1).some((fr) => fr.fn);
}

/** First line at or after `from` whose `return` the component owns, or -1. */
export function firstOwnReturn(
  lines: string[],
  atStart: Frame[][],
  from: number,
  bodyIdx: number,
  bodyLine: number
): number {
  // From the line AFTER the body's opening brace: on the declaration line itself
  // the stack is still empty, so an "am I inside?" test there breaks instantly.
  const start = Math.max(from, bodyLine + 1);
  for (let j = start; j < lines.length; j++) {
    const st = atStart[j];
    if (!inside(st, bodyIdx)) break; // left the component
    if (nestedFunction(st, bodyIdx)) continue; // inside a callback
    if (/^\s*return\b/.test(lines[j])) return j;
  }
  return -1;
}

/** Hook calls after `from` that are still inside the component. */
export function hooksAfter(
  lines: string[],
  atStart: Frame[][],
  from: number,
  bodyIdx: number,
  bodyLine: number
): { line: number; hook: string }[] {
  const out: { line: number; hook: string }[] = [];
  for (let j = Math.max(from, bodyLine + 1); j < lines.length; j++) {
    const st = atStart[j];
    if (!inside(st, bodyIdx)) break;
    const h = lines[j].match(HOOK);
    if (h) out.push({ line: j, hook: h[1] });
  }
  return out;
}

interface Violation {
  file: string;
  component: string;
  retLine: number;
  hookLine: number;
  hook: string;
}

/** Locate a component's body frame from its declaration line. */
function bodyOf(lines: string[], atStart: Frame[][], declLine: number): { idx: number; line: number } | null {
  const base = atStart[declLine].length;
  for (let j = declLine; j < Math.min(declLine + 8, lines.length); j++) {
    // The body brace opens ON one of the declaration's own lines, so it becomes
    // visible in the stack at the start of a LATER line than the declaration.
    // Comparing fr.line to j instead — which is what this did first — finds
    // nothing, and a checker that silently finds nothing is worse than none.
    const at = atStart[j].findIndex(
      (fr, k) => k >= base && fr.line >= declLine && fr.line < declLine + 8
    );
    if (at >= 0) return { idx: at, line: atStart[j][at].line };
  }
  return null;
}

function analyse(src: string): { violations: Violation[]; components: number } {
  const lines = scrub(src).split("\n");
  const atStart = frames(lines.join("\n"));
  const violations: Violation[] = [];
  let components = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(COMPONENT);
    if (!m) continue;
    const body = bodyOf(lines, atStart, i);
    if (!body) continue;
    components++;
    const ret = firstOwnReturn(lines, atStart, body.line, body.idx, body.line);
    if (ret < 0) continue;
    for (const h of hooksAfter(lines, atStart, ret + 1, body.idx, body.line)) {
      violations.push({
        file: "",
        component: m[1],
        retLine: ret + 1,
        hookLine: h.line + 1,
        hook: h.hook,
      });
    }
  }
  return { violations, components };
}

// ------------------------------------------------------------------ the app

const all: Violation[] = [];
let components = 0;
for (const file of walk(APP)) {
  const r = analyse(readFileSync(file, "utf8"));
  components += r.components;
  for (const v of r.violations) all.push({ ...v, file: path.relative(REPO, file) });
}

for (const v of all) {
  console.log(`  FAIL  ${v.file}:${v.hookLine} — ${v.component}() calls use${v.hook} after its early return at line ${v.retLine}`);
}
ok(
  all.length === 0,
  `no component calls a hook after an early return (checked ${components} components)`,
  all.map((v) => `${v.file}:${v.hookLine} ${v.component}/use${v.hook} after return@${v.retLine}`)
);

// ------------------------------------------------- the checker checks itself

// The exact shape that shipped, including the `if (…) { return … }` nesting that
// defeated the earlier indentation-based attempts.
{
  const probe = [
    "function Player() {",
    "  const { data } = useSession();",
    "  if (!data) {",
    "    return null;",
    "  }",
    "  const idx = useMemo(() => build(), [data]);",
    "  return idx;",
    "}",
  ].join("\n");
  const r = analyse(probe);
  ok(r.components === 1, "a synthetic component is recognised", r.components);
  ok(r.violations.length === 1, "and the shape that shipped is reported", r.violations);
  ok(
    r.violations[0]?.hook === "Memo" && r.violations[0]?.hookLine === 6 && r.violations[0]?.retLine === 4,
    "naming the hook, its line, and the return it follows",
    r.violations[0]
  );
}

// A return that belongs to a callback is not the component's, and the hook after
// it is fine — which is the whole reason braces are classified rather than
// compared by indentation.
{
  const probe = [
    "function Q() {",
    "  useEffect(() => {",
    "    if (!x) return;",
    "    doThing();",
    "  }, []);",
    "  const v = useMemo(() => 1, []);",
    "  return null;",
    "}",
  ].join("\n");
  ok(analyse(probe).violations.length === 0, "a return inside useEffect does not count as an early return");
}

// Every hook before the early return is fine — that is the ordinary shape.
{
  const probe = [
    "function R() {",
    "  const a = useState(1);",
    "  const b = useMemo(() => a, [a]);",
    "  if (!a) return null;",
    "  return b;",
    "}",
  ].join("\n");
  ok(analyse(probe).violations.length === 0, "hooks BEFORE the early return are fine");
}

console.log(`  ${passed}/${passed + failed} hook-order assertions passed`);
if (failed) process.exit(1);
