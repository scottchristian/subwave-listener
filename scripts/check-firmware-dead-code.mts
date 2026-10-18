// Dead code in the device firmware, found by reachability rather than by eye.
//
// THE BUG THIS EXISTS FOR. Until 1.10.0 the entire idle feature was dead: the
// screen never dimmed, never blanked and could not be woken by touch. Every piece
// was present and individually correct — `idle_apply()` implemented the three
// modes properly, `idle_touch()` armed the timer, both globals were declared and
// bound across to C++. But `idle_apply()` was called only from `idle_touch()`,
// and `idle_touch()` was called from absolutely nothing. The settings screen
// offered three working-looking idle modes and the screen obeyed none of them.
//
// Nothing about that shape is visible to a compiler, to a review of any one file,
// or to a runtime log. It is only visible as a whole: is this function reachable
// from something the device actually runs?
//
// SO THAT IS THE QUESTION. Start from the entry points — ESPHome's own component
// callbacks, and every function the YAML refers to by name — and walk the call
// graph inside the component. Whatever cannot be reached is dead, and dead code
// in a device is worse than dead code in a server: there is no way to find out at
// runtime, because the symptom is the absence of a behaviour, not an error.
//
// WHAT THIS DOES NOT CLAIM. Internal helpers are fine and are not reported.
// `resolve_host()` is called once, from one place, in the same file — that is
// ordinary C++ and it is reachable. An earlier version of this check counted name
// occurrences instead of walking the graph and flagged eleven working helpers,
// which is worse than no check at all: a gate that cries wolf gets ignored, and an
// ignored gate protects nothing.
//
// The only structural gap is callbacks invoked by a framework rather than by
// name — ESPHome triggers, LVGL event handlers, and the like. Those are listed
// explicitly in EXTERNAL_CALLBACKS, which is a maintenance point: when a new
// framework callback appears, it goes there, and a reviewer sees the addition.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FW = join(ROOT, "device/firmware");

let passed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(message);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every .cpp and .h in the component trees, excluding generated build output. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === ".esphome" || entry === "builds") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (full.endsWith(".cpp") || full.endsWith(".h") || full.endsWith(".hpp")) out.push(full);
  }
  return out;
}

/** Hand-written YAML: the entry point plus everything it includes. */
function yamlFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === ".esphome") continue;
        walk(full);
      } else if (full.endsWith(".yaml")) {
        out.push(full);
      }
    }
  };
  walk(FW);
  return out;
}

interface Fn {
  name: string;
  file: string;
  body: string;
}

/**
 * Strip comments and string literals, preserving length and newlines.
 *
 * NOT OPTIONAL. An earlier version searched function bodies as raw text, and the
 * comment I wrote explaining the bug contained the name of the function I had
 * just un-called: "Nothing called now_refresh()." That comment was on the line
 * directly above the call site, inside a reachable body, so the gate read it as a
 * caller and reported the code as live.
 *
 * A mutation test — delete the real call, expect the gate to fail — passed on
 * three of four mutations because of it. A gate that a comment can switch off is
 * not a gate; it is a comment reader.
 *
 * Newlines are kept so that a reported line number still means something.
 * Character positions are preserved too, so the brace matching in
 * parseFunctions() can run on the stripped text without any offset arithmetic.
 */
function stripCommentsAndStrings(src: string, yaml = false): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // YAML line comment. Only when asked, because `#` is the preprocessor
    // directive marker in C++ and stripping it there would delete every #define.
    //
    // This was NOT optional either. The first version knew only `//`, so an
    // apostrophe in a YAML comment — "the screen's own settings screen" — opened
    // a string literal that ran to the next apostrophe, and another ran on, until
    // the rest of the file had been blanked. Eleven live functions were reported
    // as dead. A YAML file is full of prose; a stripper that does not know it is
    // YAML does not survive contact with one.
    if (yaml && ch === "#") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    // Line comment.
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    // Block comment.
    if (ch === "/" && next === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        if (src[i + 1] !== undefined) out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    // String or character literal. Replace the contents, keep the delimiters so
    // that a `")("` inside a literal cannot unbalance the paren scan.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out[i] = " ";
          if (src[i + 1] !== undefined) out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

const NOT_A_FUNCTION = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "else", "do",
  "new", "delete", "throw", "case", "defined", "typeof",
]);

/**
 * Function definitions with their bodies.
 *
 * Brace matching rather than a regex alone, because a body can contain a lambda
 * with braces in it and a regex that stops at the first `}` truncates the call
 * graph exactly where it gets interesting — inside a deferred callback.
 *
 * THE DEFINITION TEST IS A CLOSING BRACE, NOT A LINE SHAPE. The obvious approach
 * — a regex anchored to the start of a line, with the return type captured
 * separately — silently misses every `Type::method()` definition, because
 * `SubwaveDisplay::check_connectivity` ends in `:` and not in whitespace. When
 * that happened this check reported eleven working helpers as orphans while
 * quietly ignoring the entire member-function layer, which is most of the
 * component. A gate that misses the thing it was written for is worse than none.
 *
 * So: find any `name(...)` whose closing paren is followed by `{`, and require
 * that the name is not preceded by `.`, `->`, `:` or a word character. That last
 * part is what separates `resolve_host()` from `obj.resolve_host()` — a
 * definition is introduced by its type or by `::`, a call by nothing at all.
 */
function parseFunctions(source: string, file: string): Fn[] {
  const out: Fn[] = [];
  const head = /([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;{}()]*)\)\s*(?:const\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(source)) !== null) {
    const name = m[1];
    if (NOT_A_FUNCTION.has(name)) continue;

    const before = source.slice(Math.max(0, m.index - 2), m.index);
    // `::` is the member-definition marker — `SubwaveDisplay::loop()` — and must
    // be ACCEPTED. A single `:` is `case x:` or a ternary and must not. Getting
    // this backwards is not hypothetical: it silently hid every member function
    // from the graph, which is most of the component.
    if (m.index === 0) continue;
    if (!before.endsWith("::")) {
      const prev = before.slice(-1);
      if (prev === "." || prev === ">" || prev === ":" || /\w/.test(prev)) continue;
    }

    const open = source.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ name, file, body: source.slice(open, i + 1) });
    head.lastIndex = i;
  }
  return out;
}

/** Callbacks the framework invokes by name, not by a call we can see. */
const EXTERNAL_CALLBACKS = new Set([
  // ESPHome component lifecycle. Called by App, not by us.
  "setup",
  "loop",
  "dump_config",
  "update",
  // Called from web_server's handler registry, which holds the pointer.
  "render",
  // Passed to wifi as a scan-results listener.
  "on_wifi_scan_results",
  // web_server_idf::AsyncWebHandler overrides. The base class calls these by
  // virtual dispatch, so there is no call site in this tree to point at.
  "canHandle",
  "handleRequest",
]);

/**
 * Macros are an edge the source cannot see.
 *
 * `lookup()` is called by the OBJ / INT / BOOL / U32 macros, which are expanded
 * at their use sites — so the name appears in every painter's body and still has
 * no caller the parser can find. Any function named on a `#define` line is
 * therefore an entry point, which is not a loophole: the macro is the call site,
 * written once.
 */
const cpp = sourceFiles(FW).filter((f) => f.endsWith(".cpp"));
const headers = sourceFiles(FW).filter((f) => !f.endsWith(".cpp"));
const yamls = yamlFiles();

const macroSources: string[] = [];
for (const path of [...cpp, ...headers]) {
  for (const line of read(path).split("\n")) {
    if (/^\s*#\s*define\b/.test(line)) macroSources.push(stripCommentsAndStrings(line));
  }
}

// Parsed from stripped text, so neither a comment nor a log message can define a
// function or appear to call one.
const functions: Fn[] = cpp.flatMap((f) => parseFunctions(stripCommentsAndStrings(read(f)), f));
const byName = new Map<string, Fn[]>();
for (const fn of functions) {
  const list = byName.get(fn.name) ?? [];
  list.push(fn);
  byName.set(fn.name, list);
}

// ---------------------------------------------------------------------------
// Entry points.
//
// A function named in YAML is reached by name at the moment ESPHome generates
// main.cpp, so that is a real edge — and it is the only edge out of the component
// that we can prove. Anything not reachable from here is not run.
// ---------------------------------------------------------------------------
const yamlBlob = yamls.map((f) => stripCommentsAndStrings(read(f), true)).join("\n");

const reachable = new Set<string>();
const queue: string[] = [];

for (const name of byName.keys()) {
  if (EXTERNAL_CALLBACKS.has(name)) {
    reachable.add(name);
    queue.push(name);
  }
}
for (const name of byName.keys()) {
  if (new RegExp(`\\b${name}\\b`).test(yamlBlob) || macroSources.some((l) => new RegExp(`\\b${name}\\b`).test(l))) {
    if (!reachable.has(name)) {
      reachable.add(name);
      queue.push(name);
    }
  }
}

// Walk the graph. Every token that names a defined function is an edge, which
// covers method calls, static calls and calls inside nested lambdas alike.
while (queue.length > 0) {
  const current = queue.pop()!;
  for (const fn of byName.get(current) ?? []) {
    for (const candidate of byName.keys()) {
      if (reachable.has(candidate)) continue;
      if (new RegExp(`\\b${candidate}\\b`).test(fn.body)) {
        reachable.add(candidate);
        queue.push(candidate);
      }
    }
  }
}

const orphans = [...byName.keys()]
  .filter((n) => !reachable.has(n))
  .sort()
  // Constructors and destructors are named after their type and are invoked by
  // the compiler, not by a call.
  .filter((n) => !/^~|^(SubwaveDisplay|SubwaveSetupWeb)$/.test(n));

// The orphan list is the whole assertion. `idle_touch` sat in it for the life of
// the firmware, which is the point of having written it.
assert(
  orphans.length === 0,
  `unreachable functions (declared, compiled, never called): ${orphans.join(", ")}`,
);

// ---------------------------------------------------------------------------
// The specific regression, asserted by name as well.
//
// Reachability proves the mechanism but not the intent. `idle_touch` could be
// made reachable again by being called from something useless, and this gate
// would go quiet while the screen still never dimmed. So the contract is stated
// separately: a touch must arm the deadline, and a tick must consume it.
// ---------------------------------------------------------------------------
const yamlAndScripts = yamlBlob;
assert(
  /on_touch:[\s\S]{0,400}?idle_arm/.test(yamlAndScripts),
  "the touchscreen must fire idle_arm on touch — without it the screen cannot wake",
);
assert(
  /interval: 5s[\s\S]{0,400}?idle_tick/.test(yamlAndScripts),
  "an interval must drive idle_tick — without it the deadline is never noticed",
);
assert(
  /boot_windows/.test(yamlAndScripts) &&
    /lv_obj_add_flag\(id\(setup_wifi_screen\), LV_OBJ_FLAG_HIDDEN\)/.test(yamlAndScripts) &&
    /lv_obj_add_flag\(id\(setup_bind_screen\), LV_OBJ_FLAG_HIDDEN\)/.test(yamlAndScripts),
  "boot must hide both setup screens — every slot in window_stack is created visible, " +
    "so without this the setup screen draws over the now-playing screen",
);

if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n${failures.length} dead-code assertion(s) failed.`);
  process.exit(1);
}
console.log(`${passed}/${passed} dead-code assertions passed`);