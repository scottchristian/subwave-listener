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
import {
  PANEL_H,
  PANEL_W,
  SCREENS,
  parseKeyboardState,
  parseWidgets,
  screenPath,
  scriptsPath,
} from "./lib/setup-layout.mts";

const ROOT = process.cwd();
const SETUP = screenPath(ROOT, "setup");
const SCRIPTS = scriptsPath(ROOT);

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

const setup = parseWidgets(SETUP);

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
//
// NOTHING MOVES WHEN THE KEYBOARD OPENS. That is the design, arrived at after a
// version that raised the field got two collisions no assertion could see. The
// consequence worth checking is therefore simpler: the keyboard must start
// BELOW the field, and must not start below it by an accident that is hard to
// see — two numbers 50px apart read the same in a diff as two numbers 5px apart.
const kb = setup.get("wifi_keyboard");
const pw = setup.get("wifi_password");
const connect = setup.get("setup_connect_button");

ok(kb !== undefined, "wifi_keyboard is declared");
ok(pw !== undefined, "wifi_password is declared");
ok(kb?.y !== null && kb?.y !== undefined, "wifi_keyboard has an absolute y");
ok(kb?.h !== null && kb?.h !== undefined, "wifi_keyboard has an explicit height");

if (kb && pw && pw.y !== null && pw.h !== null && kb.y !== null) {
  const fieldBottom = pw.y + pw.h;
  ok(
    kb.y >= fieldBottom + 8,
    "the keyboard clears the password field with a visible gap",
    `field ends ${fieldBottom}, keyboard starts ${kb.y} — no gap`,
  );
  ok(
    kb.y + kb.h! <= PANEL_H,
    "the keyboard fits on the panel",
    `y=${kb.y} + h=${kb.h} = ${kb.y + kb.h!} > ${PANEL_H}`,
  );
  ok(
    kb.h! >= 160,
    "the keyboard is tall enough to type on",
    `${kb.h}px is a strip rather than a keyboard`,
  );
}

// The mode row lives in the field's row, to the right of it. Four 136px buttons
// and a Done need 780px, and the field takes 400 — so anything wider than about
// 520px of field would push them off the panel.
if (kb && pw && pw.w !== null && pw.h !== null && kb.y !== null) {
  // Sharing a row means sharing a TOP edge, not a bottom edge. The buttons are
  // the same height as the field, so comparing bottoms would test nothing.
  const modeRow = pw.y;
  const buttons = ["wifi_mode_lower", "wifi_mode_upper", "wifi_mode_special", "wifi_mode_number", "wifi_keyboard_done"];
  const inRow = buttons.filter((id) => setup.get(id)?.y === modeRow);
  ok(
    inRow.length === buttons.length,
    "every keyboard button shares the password field's row",
    `found ${inRow.length}/${buttons.length} at y=${modeRow}`,
  );
  const last = setup.get("wifi_keyboard_done");
  if (last && last.x !== null && last.w !== null) {
    ok(
      last.x + last.w <= PANEL_W,
      "the Done button stays on the panel",
      `ends at ${last.x + last.w}`,
    );
    ok(
      pw.x !== null && last.x > pw.x + pw.w,
      "the keyboard buttons sit clear of the password field",
      `Done starts at ${last.x}, field ends at ${(pw.x ?? 0) + pw.w}`,
    );
  }
}

// The two widgets the field's row cannot also hold are hidden while typing.
// Without this they sit under the character-set buttons and both are unreachable.
const scriptSrc = fs.existsSync(SCRIPTS) ? fs.readFileSync(SCRIPTS, "utf8") : "";
for (const id of ["setup_connect_button", "wifi_status"]) {
  ok(scriptSrc.includes(`id(${id})`), `the keyboard toggle accounts for ${id}`);
}
const toggle = scriptSrc.slice(
  scriptSrc.indexOf("- id: wifi_keyboard_toggle"),
  scriptSrc.indexOf("- id: wifi_keyboard_mode"),
);
ok(
  /lv_obj_add_flag/.test(toggle.slice(toggle.indexOf("if (opening)"), toggle.indexOf("} else {"))),
  "the opening branch HIDES what the keyboard covers",
);

// And nothing may move at all. This is the assertion that would have caught
// both collisions in the version that raised the field: a widget whose position
// is written outside setup.yaml is a position no amount of reading the YAML
// will reveal.
const toggleMoves = (toggle.match(/lv_obj_set_(?:x|y)\(/g) ?? []).length;
ok(
  toggleMoves === 0,
  "the keyboard toggle moves no widget",
  `${toggleMoves} position write(s) in the toggle — every move is a possible stranded caption`,
);

// ---------------------------------------------------------------------------
// 5. EVERY screen, not just the setup one.
// ---------------------------------------------------------------------------
// The setup screen was checked because it was the only one anybody had looked
// at. The other three had never been drawn or asserted, which is precisely how
// the setup screen ended up with a title overlapping a label, two character-set
// buttons under a third, and a byline sitting on top of the artwork.
//
// The overlap assertion is the one that earns its keep. It needs widgets that
// declare BOTH a position and a size. A label has no `height:` — LVGL derives it
// from the font and the wrapped line count — so there is no box to test, and
// inventing one from a font size produces false positives on every screen that
// wraps a title.
//
// SO THE TWO TOOLS COVER DIFFERENT THINGS, AND NEITHER IS REDUNDANT. The gate
// covers widgets with declared boxes: controls, rules, images, hairlines. The
// renderer covers text, because it draws glyphs at real sizes. A title
// overlapping a label is visible in the picture and invisible here; a button
// landing on top of a 520-square cover is caught by both.
//
// HIDDEN AND NESTED WIDGETS ARE SKIPPED, and both exclusions are load-bearing.
//
// Hidden: both artwork widgets are hidden until a cover arrives, and two hidden
// 520-square images stacked at the same coordinates IS the design — outgoing
// under incoming. Asserting on that would fail on purpose.
//
// Nested: a child is positioned relative to its parent, so a button and the
// label inside it share coordinates by design. Comparing those would fail on
// every button that has a label in it.
for (const name of SCREENS) {
  const widgets = parseWidgets(screenPath(ROOT, name));
  ok(widgets.size > 0, `${name}.yaml yields widgets`, `${widgets.size}`);

  for (const [id, w] of widgets) {
    if (w.y === null) continue;
    ok(
      w.y + (w.h ?? 0) <= PANEL_H,
      `${name}: ${id} fits on the panel`,
      `y=${w.y} + h=${w.h ?? 0} = ${w.y + (w.h ?? 0)} > ${PANEL_H}`,
    );
  }

  // HIDDEN WIDGETS ARE INCLUDED, and only a PAIR of hidden widgets is skipped.
  //
  // The first version filtered hidden widgets out, which quietly removed the
  // most valuable case there is. Both artwork widgets are hidden until a cover
  // arrives, so "put a control on top of the artwork" passed — and then failed
  // the moment a cover arrived and `art_in` went visible. A check that cannot
  // see a collision that only exists at runtime is not checking the layout.
  //
  // What genuinely stacks is the pair: `art_out` and `art_in` sit at identical
  // coordinates on purpose, the outgoing cover underneath the incoming one. That
  // is the only reason a hidden-pair exemption exists, and it is narrow on
  // purpose.
  // TOP-LEFT (or unanchored, which is LVGL's default) only. Under any other
  // anchor x and y are offsets from a different corner, so the pair above is not
  // a box and comparing them invents collisions. A widget that says
  // `align: BOTTOM_LEFT, y: -88px` is not 88px from the top.
  const boxes = [...widgets.values()].filter(
    (w) =>
      !w.nested &&
      (w.align === null || w.align === "TOP_LEFT") &&
      w.x !== null &&
      w.y !== null &&
      w.w !== null &&
      w.h !== null,
  );
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.hidden && b.hidden) continue;

      // THE ONE DELIBERATE COINCIDENCE besides the artwork pair: the keyboard's
      // own buttons and the controls they replace. The mode row and Done sit
      // exactly where Connect and the status line are, because that row is the
      // password field's row and there is only one of it. The toggle shows one
      // set and hides the other, so they are never on screen together.
      //
      // Exempted only for pairs the toggle ACTUALLY makes exclusive — one id
      // from each list. Anything else at the same coordinates is a collision
      // that no amount of toggling explains.
      const kbState = parseKeyboardState(ROOT);
      const exclusive = (p: string, q: string) =>
        (kbState.shownWhileTyping.includes(p) && kbState.hiddenWhileTyping.includes(q)) ||
        (kbState.shownWhileTyping.includes(q) && kbState.hiddenWhileTyping.includes(p));
      if (exclusive(a.id, b.id)) continue;
      const overlapX = a.x! < b.x! + b.w! && b.x! < a.x! + a.w!;
      const overlapY = a.y! < b.y! + b.h! && b.y! < a.y! + a.h!;
      ok(
        !(overlapX && overlapY),
        `${name}: ${a.id} and ${b.id} do not overlap`,
        `a(${a.x},${a.y},${a.w}x${a.h}${a.hidden ? ", hidden" : ""}) ` +
          `b(${b.x},${b.y},${b.w}x${b.h}${b.hidden ? ", hidden" : ""})`,
      );
    }
  }
}

console.log(`  ${passed}/${passed + failed} screen-layout assertions passed`);
process.exit(failed === 0 ? 0 : 1);
