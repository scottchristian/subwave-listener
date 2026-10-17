// The setup screen's layout, which cannot be seen from this bench.
//
// WHY THIS EXISTS. Everything else about the panel is verifiable: the init
// sequence is check-panel-init, the scan is a boot log, the panel's revision is
// a diff. The LAYOUT is not. There is no camera on this bench, the screen is
// bolted to a wall, and the only person who can tell whether the eight
// networks in the picker are legible is somebody standing in front of it.
//
// That is exactly the situation this suite exists for elsewhere —
// check-panel-init exists because a panel that renders nothing looks identical
// to a panel configured correctly. Same trap, different layer.
//
// THE TWO FAULTS, both of which have already happened once.
//
// 1. A WIDGET OFF THE BOTTOM OF THE PANEL. The panel is 1280x800 and the setup
//    screen was already full to y=788 before the keyboard existed. Adding an
//    element without moving anything puts it past 800, where it is simply not
//    drawn — no error, no warning, and the log is clean.
//
// 2. THE KEYBOARD COVERING THE FIELD IT IS TYPING INTO. The password field
//    sits at the bottom of the screen and the keyboard rises over the bottom of
//    the screen. If either moves and the other does not, the person types into
//    something they cannot see. This is invisible in every log and obvious the
//    moment a human looks, which is precisely the problem.
//
// The two y values are duplicated between setup.yaml and scripts.yaml — the
// field's resting position and its raised position. That duplication is what
// makes fault 2 possible at all, so it is checked rather than trusted.
//
// Neither fault needs ESPHome, a compiler or hardware. Both are decidable by
// reading the YAML, which is why they belong in the check suite.
//
// Run: npm run check:screen-layout
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SETUP = path.join(ROOT, "device", "firmware", "common", "screens", "setup.yaml");
const SCRIPTS = path.join(ROOT, "device", "firmware", "common", "screens", "scripts.yaml");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

/** The panel's usable height. Every widget must fit inside this. */
const PANEL_H = 800;

/**
 * One LVGL widget block from the setup screen: its id, x, y, width and height.
 *
 * A scan of the YAML by indentation rather than a YAML parse, for the same
 * reason check-panel-init does it: the files use ESPHome tags (`!include`) that
 * a stock loader rejects, and because the thing worth checking is the geometry
 * AS WRITTEN — a parse-and-reemit would normalise exactly the values under
 * suspicion.
 */
interface Widget {
  id: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}

function widgets(file: string): Map<string, Widget> {
  const out = new Map<string, Widget>();
  if (!fs.existsSync(file)) return out;

  const lines = fs.readFileSync(file, "utf8").split("\n");

  // `- <kind>:` opens a widget; its properties are indented under it.
  const start = lines.findIndex((l) => /^- \w+:/.test(l));
  if (start === -1) return out;

  let cur: Widget | null = null;
  for (const raw of lines.slice(start)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    if (/^- \w+:/.test(raw)) {
      cur = { id: "", x: null, y: null, w: null, h: null };
      out.set(`__pending_${out.size}`, cur);
      continue;
    }
    if (!cur) continue;

    const id = raw.match(/^\s+id:\s*(\S+)/);
    if (id) {
      cur.id = id[1];
      continue;
    }
    const num = (key: string): number | null => {
      const m = raw.match(new RegExp(`^\\s+${key}:\\s*(-?[\\d.]+)\\s*(px)?\\s*$`));
      return m ? Math.round(Number(m[1])) : null;
    };
    const v = num("x");
    if (v !== null) cur.x = v;
    const yv = num("y");
    if (yv !== null) cur.y = yv;
    const wv = num("width");
    if (wv !== null) cur.w = wv;
    const hv = num("height");
    if (hv !== null) cur.h = hv;
  }

  const byId = new Map<string, Widget>();
  for (const w of out.values()) if (w.id) byId.set(w.id, w);
  return byId;
}

const setup = widgets(SETUP);

ok(fs.existsSync(SETUP), "setup.yaml found");
ok(setup.size > 0, "setup.yaml yields widgets", `${setup.size} widget(s)`);

// ---------------------------------------------------------------------------
// 1. Everything fits on the panel.
// ---------------------------------------------------------------------------
// Only widgets with an ABSOLUTE y are decidable. A widget positioned by align
// alone (bottom-right, centred) is placed by LVGL and is out of scope; the ones
// that caused the original overflow were all absolutely positioned.
for (const [id, w] of setup) {
  if (w.y === null) continue;
  const bottom = w.y + (w.h ?? 0);
  ok(
    bottom <= PANEL_H,
    `${id} fits on the panel`,
    `y=${w.y} + h=${w.h ?? 0} = ${bottom} > ${PANEL_H}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The keyboard does not cover the field it types into.
// ---------------------------------------------------------------------------
const kb = setup.get("wifi_keyboard");
const pw = setup.get("wifi_password");
ok(kb !== undefined, "wifi_keyboard is declared");
ok(pw !== undefined, "wifi_password is declared");

if (kb && pw) {
  ok(kb.y !== null, "wifi_keyboard has an absolute y");
  ok(kb.h !== null, "wifi_keyboard has an explicit height");
}

// scripts.yaml carries the RAISED position the field moves to when the keyboard
// opens. That is the value that has to clear the keyboard's top edge.
const scriptSrc = fs.existsSync(SCRIPTS) ? fs.readFileSync(SCRIPTS, "utf8") : "";
const raised = scriptSrc.match(/lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\)/);

ok(raised !== null, "scripts.yaml raises the password field when the keyboard opens");
if (raised && kb && kb.y !== null && pw && pw.h !== null) {
  const raisedY = Number(raised[1]);
  ok(
    raisedY + pw.h <= kb.y,
    "the raised password field clears the top of the keyboard",
    `field ends at ${raisedY + pw.h}, keyboard starts at ${kb.y}`,
  );
}

// The field's RESTING position must be put back when the keyboard closes.
//
// This is three assertions, not one, because a count is not enough. Counting the
// lv_obj_set_y calls passes even when the CLOSING one is gone — the opening call
// is still there, the field stays parked under the keyboard, and the check that
// was supposed to prevent exactly that reports green. So: there must be both
// calls, they must differ, and the closing one must match the position declared
// in setup.yaml.
//
// The last of those is the one that actually binds the two files together. The
// resting y lives in setup.yaml, and the keyboard script has to restore THAT
// value — not a copy of it that someone later edits in one place only.
const moves = [...scriptSrc.matchAll(/lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\)/g)].map(
  (m) => Number(m[1]),
);
ok(moves.length === 2, "scripts.yaml moves the password field on open AND on close", `found ${moves.length}`);
if (moves.length === 2) {
  ok(
    moves[0] !== moves[1],
    "the field is raised when the keyboard opens and lowered when it closes",
    `both are ${moves[0]}`,
  );
  if (pw && pw.y !== null) {
    ok(
      moves[1] === pw.y,
      "the closing position matches the field's declared y in setup.yaml",
      `scripts.yaml restores ${moves[1]}, setup.yaml declares ${pw.y}`,
    );
  }
}

if (pw && pw.y !== null) {
  ok(
    pw.y === setup.get("setup_connect_button")?.y,
    "the password field and the Connect button share a row",
    `field y=${pw.y}, button y=${setup.get("setup_connect_button")?.y}`,
  );
}

// ---------------------------------------------------------------------------
// 3. The keyboard is reachable, and dismissible.
// ---------------------------------------------------------------------------
// A keyboard with no way to close it is a screen you cannot leave, and the only
// dismiss affordances here are taps on other widgets.
ok(
  /id:\s*wifi_keyboard_done/.test(fs.readFileSync(SETUP, "utf8")),
  "there is a Done button to dismiss the keyboard",
);
ok(
  /lv_textarea_get_text\(id\(wifi_password\)\)/.test(scriptSrc),
  "the connect script reads the password back out of the field",
);

// LVGL shows exactly one character set at a time and does not cycle. Without all
// four modes reachable, some real passwords cannot be typed at all.
for (const mode of ["wifi_mode_lower", "wifi_mode_upper", "wifi_mode_special", "wifi_mode_number"]) {
  ok(setup.has(mode), `${mode} is declared`);
}

console.log(`  ${passed}/${passed + failed} screen-layout assertions passed`);
process.exit(failed === 0 ? 0 : 1);
