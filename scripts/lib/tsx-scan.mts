// A small TypeScript/TSX scanner, shared by the hook-rule checks.
//
// It exists because two earlier versions of the hook checker were written
// independently and both were wrong in different ways: one compared indentation,
// one assumed a fixed brace depth. Both reported ZERO findings on a file that
// was broken in exactly the way they were supposed to catch. The rule they
// enforce is fiddly enough that it should have one implementation.
//
// What it provides:
//   scrub()        — comments and string bodies blanked, so braces inside them
//                    cannot be counted
//   frames()       — the brace stack at the start of each line, each frame
//                    tagged `fn` (a function body) or `blk` (a block)
//   components()   — every component with its body frame located
//   hookOn()       — the hook a line calls, if any
//
// The distinction that matters: `if (x) { return … }` puts the return one brace
// deeper than the body and is still the COMPONENT's return, while a `return`
// inside `useEffect(() => { … })` belongs to the callback. Indentation cannot
// tell those apart. Brace kind can.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Blanks comments and string bodies so braces inside them cannot be counted. */
export function scrub(src: string): string {
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
      return body
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    })
    .join("\n");
}

/** Hook names this scanner recognises. */
export const HOOKS = [
  "State", "Effect", "Ref", "Memo", "Callback", "Reducer", "Context",
  "LayoutEffect", "ImperativeHandle", "DebugValue", "Optimistic", "ActionState",
  "Transition", "DeferredValue", "SyncExternalStore", "Id",
  // Third-party hooks the app actually calls. Counting these matters for the
  // reachability invariant: a component whose FIRST hook is useSession and which
  // returns early below it is off by one, and leaving it uncounted hid exactly
  // that in the first run of this check.
  "Session",
];

export const HOOK_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_$])(?:React\\.)?use(${HOOKS.join("|")})\\s*\\(`
);

const COMPONENT_RE = /^(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/;

/** Keywords that take a parenthesised head but are NOT function bodies. */
const CONTROL = new Set([
  "if", "for", "while", "switch", "catch", "else", "do", "try", "with",
  "return", "typeof", "await", "new", "delete", "in", "of", "case",
]);

/**
 * Is the `{` at the end of `before` opening a function body rather than a block?
 *
 * `if (x) {`, `switch (x) {` and `catch (e) {` must NOT match — all three take a
 * parenthesised head and all three are blocks. A method shorthand `onHost() {`
 * and an arrow `() => {` must. Wrong in either direction silently hides or
 * invents findings, which is worse than not checking at all.
 */
export function isFunctionHead(before: string): boolean {
  const t = before.replace(/\s+$/, "");
  if (/=>$/.test(t)) return true;
  if (/\b(?:async\s+)?function\b(?:\s+[A-Za-z0-9_$]+)?\s*(?:\([^)]*\))?$/.test(t)) return true;
  const call = t.match(/([A-Za-z0-9_$]+)\s*(?:\([^()]*\))?$/);
  if (call) return !CONTROL.has(call[1]);
  return false;
}

export interface Frame {
  fn: boolean;
  line: number;
}

/** The brace stack at the start of each line, each frame tagged with its opener's line. */
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

export interface Component {
  name: string;
  declLine: number;
  /** Index of this component's own body frame in the stack. */
  bodyIdx: number;
  /** Line that opened the body. */
  bodyLine: number;
}

function bodyOf(atStart: Frame[][], declLine: number): { idx: number; line: number } | null {
  const base = atStart[declLine].length;
  for (let j = declLine; j < Math.min(declLine + 8, atStart.length); j++) {
    // The body brace opens ON one of the declaration's own lines, so it becomes
    // visible in the stack at the start of a LATER line than the declaration.
    const at = atStart[j].findIndex(
      (fr, k) => k >= base && fr.line >= declLine && fr.line < declLine + 8
    );
    if (at >= 0) return { idx: at, line: atStart[j][at].line };
  }
  return null;
}

/** Every component in a source file, with its body frame located. */
export function components(lines: string[], atStart: Frame[][]): Component[] {
  const out: Component[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(COMPONENT_RE);
    if (!m) continue;
    const body = bodyOf(atStart, i);
    if (!body) continue;
    out.push({ name: m[1], declLine: i, bodyIdx: body.idx, bodyLine: body.line });
  }
  return out;
}

/** The hook a line calls, if any. */
export function hookOn(line: string): string | null {
  const m = line.match(HOOK_RE);
  return m ? m[1] : null;
}

/**
 * Does this line carry a `return` belonging to the enclosing component?
 *
 * Not just a line that STARTS with `return`: `if (a) return null;` is the same
 * kind of short-circuit, and matching only the leading form missed it — which is
 * how a probe in the checker's own self-tests failed while the app scan quietly
 * reported the wrong hook counts.
 *
 * A `return` that appears after an `=>` on the same line belongs to that arrow,
 * so it is excluded. Combined with the brace-kind check for braces opened on
 * earlier lines, that covers both shapes.
 */
export function ownReturnOn(line: string): boolean {
  const r = line.search(/\breturn\b/);
  if (r < 0) return false;
  const arrow = line.indexOf("=>");
  return arrow < 0 || r < arrow;
}

/** True while line `j` is still inside this component. */
export function inside(st: Frame[], bodyIdx: number): boolean {
  return st.length > bodyIdx;
}

/** True when a FUNCTION frame sits strictly inside the component's own body. */
export function inNestedFunction(st: Frame[], bodyIdx: number): boolean {
  return st.slice(bodyIdx + 1).some((fr) => fr.fn);
}

/** Every `.tsx` under a directory. */
export function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkTsx(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Every `.ts` under a directory. */
export function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
