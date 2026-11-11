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
const SETUP_WIFI = screenPath(ROOT, "setup_wifi");
const SETUP_BIND = screenPath(ROOT, "setup_bind");
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

const setup_wifi = parseWidgets(SETUP_WIFI);
const setup_bind = parseWidgets(SETUP_BIND);

ok(fs.existsSync(SETUP_WIFI), "setup_wifi.yaml found");
ok(setup_wifi.size > 0, "setup_wifi.yaml yields widgets", `${setup_wifi.size} widget(s)`);
ok(fs.existsSync(SETUP_BIND), "setup_bind.yaml found");
ok(setup_bind.size > 0, "setup_bind.yaml yields widgets", `${setup_bind.size} widget(s)`);

// ---------------------------------------------------------------------------
// 1. Everything fits on the panel.
// ---------------------------------------------------------------------------
// Only widgets with an ABSOLUTE y are decidable. A widget positioned by align
// alone (bottom-right, centred) is placed by LVGL and is out of scope; the ones
// that caused the original overflow were all absolutely positioned.
for (const [id, w] of setup_wifi) {
  if (w.y === null) continue;
  const bottom = w.y + (w.h ?? 0);
  ok(
    bottom <= PANEL_H,
    `${id} fits on the panel`,
    `y=${w.y} + h=${w.h ?? 0} = ${bottom} > ${PANEL_H}`,
  );
}
for (const [id, w] of setup_bind) {
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
const kb_wifi = setup_wifi.get("wifi_kb");
const pw_wifi = setup_wifi.get("wifi_password");
const kb_bind = setup_bind.get("bind_kb");
const pw_bind = setup_bind.get("bind_server_url");

ok(kb_wifi !== undefined, "wifi_kb is declared (Wi-Fi page)");
ok(pw_wifi !== undefined, "wifi_password is declared (Wi-Fi page)");
ok(kb_wifi?.y !== null && kb_wifi?.y !== undefined, "wifi_kb has an absolute y (Wi-Fi page)");
ok(kb_wifi?.h !== null && kb_wifi?.h !== undefined, "wifi_kb has an explicit height (Wi-Fi page)");

if (kb_wifi && pw_wifi && pw_wifi.y !== null && pw_wifi.h !== null && kb_wifi.y !== null) {
  const fieldBottom = pw_wifi.y + pw_wifi.h;
  ok(
    kb_wifi.y >= fieldBottom + 8,
    "the Wi-Fi keyboard clears the password field with a visible gap",
    `field ends ${fieldBottom}, keyboard starts ${kb_wifi.y} — no gap`,
  );
  ok(
    kb_wifi.y + kb_wifi.h! <= PANEL_H,
    "the Wi-Fi keyboard fits on the panel",
    `y=${kb_wifi.y} + h=${kb_wifi.h!} = ${kb_wifi.y + kb_wifi.h!} > ${PANEL_H}`,
  );
  ok(
    kb_wifi.h! >= 160,
    "the Wi-Fi keyboard is tall enough to type on",
    `${kb_wifi.h}px is a strip rather than a keyboard`,
  );
}

ok(kb_bind !== undefined, "bind_kb is declared (Bind page)");
ok(pw_bind !== undefined, "bind_server_url is declared (Bind page)");
ok(kb_bind?.y !== null && kb_bind?.y !== undefined, "bind_kb has an absolute y (Bind page)");
ok(kb_bind?.h !== null && kb_bind?.h !== undefined, "bind_kb has an explicit height (Bind page)");

if (kb_bind && pw_bind && pw_bind.y !== null && pw_bind.h !== null && kb_bind.y !== null) {
  const fieldBottom = pw_bind.y + pw_bind.h;
  ok(
    kb_bind.y >= fieldBottom + 8,
    "the Bind keyboard clears the server URL field with a visible gap",
    `field ends ${fieldBottom}, keyboard starts ${kb_bind.y} — no gap`,
  );
  ok(
    kb_bind.y + kb_bind.h! <= PANEL_H,
    "the Bind keyboard fits on the panel",
    `y=${kb_bind.y} + h=${kb_bind.h!} = ${kb_bind.y + kb_bind.h!} > ${PANEL_H}`,
  );
  ok(
    kb_bind.h! >= 160,
    "the Bind keyboard is tall enough to type on",
    `${kb_bind.h}px is a strip rather than a keyboard`,
  );
}

// The mode row lives in the field's row, to the right of it. Four 136px buttons
// and a Done need 780px, and the field takes 400 — so anything wider than about
// 520px of field would push them off the panel.
if (kb_wifi && pw_wifi && pw_wifi.w !== null && pw_wifi.h !== null && kb_wifi.y !== null) {
  // Sharing a row means sharing a TOP edge, not a bottom edge. The buttons are
  // the same height as the field, so comparing bottoms would test nothing.
  const modeRow = pw_wifi.y;
  const buttons = ["wifi_mode_lower", "wifi_mode_upper", "wifi_mode_special", "wifi_mode_number", "wifi_keyboard_done"];
  const inRow = buttons.filter((id) => setup_wifi.get(id)?.y === modeRow);
  ok(
    inRow.length === buttons.length,
    "every keyboard button shares the password field's row",
    `found ${inRow.length}/${buttons.length} at y=${modeRow}`,
  );
  const last = setup_wifi.get("wifi_keyboard_done");
  if (last && last.x !== null && last.w !== null) {
    ok(
      last.x + last.w <= PANEL_W,
      "the Done button stays on the panel",
      `ends at ${last.x + last.w}`,
    );
    ok(
      pw_wifi.x !== null && last.x > pw_wifi.x + pw_wifi.w,
      "the keyboard buttons sit clear of the password field",
      `Done starts at ${last.x}, field ends at ${(pw_wifi.x ?? 0) + pw_wifi.w}`,
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
  /lv_obj_add_flag/.test(toggle.slice(toggle.indexOf("if (kb_was_hidden)"), toggle.indexOf("} else {"))),
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
  `${toggleMoves} position write(s) in the toggle — every move is a possible stranded collision`,
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

// ---------------------------------------------------------------------------
// The Now Playing co-host portrait, and the one pair it is exempt from.
// ---------------------------------------------------------------------------
// `now_avatar_2_well` occupies the space the live lamp occupies when a show has
// a single host: the well is hidden and the lamp sits at x=172. Revealing the
// co-host is the SAME call that moves the lamp across (x=272) and widens the
// text column, and hiding it moves both back — `ui_apply_now_avatar_2()` and
// `ui_hide_now_avatar_2()` drive `ui_set_now_avatar_dual()` in both directions.
// There is no state where the lamp and the well are drawn at the same
// coordinates, which is the same narrow test the keyboard exemption applies.
//
// THE NUMBERS ARE READ OUT OF THE C++, NOT RESTATED HERE. If somebody moves the
// lamp or the well without updating the toggle, `cohostExclusive` goes false,
// the exemption disappears, and the overlap assertion below fires again.
function cppFunction(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return "";
  const end = src.indexOf("\n}\n", start);
  return end < 0 ? "" : src.slice(start, end + 3);
}

const uiSource = fs.readFileSync(
  path.join(ROOT, "device/firmware/subwave_display/ui.cpp"),
  "utf8",
);
const dualFn = cppFunction(uiSource, "void ui_set_now_avatar_dual(");
const cohostShowFn = cppFunction(uiSource, "void ui_apply_now_avatar_2(");
const cohostHideFn = cppFunction(uiSource, "void ui_hide_now_avatar_2(");
const lampMove = /lv_obj_set_x\(lamp,\s*dual \? (\d+) : (\d+)\)/.exec(dualFn);
const nowWidgets = parseWidgets(screenPath(ROOT, "now"));
const cohostWell = nowWidgets.get("now_avatar_2_well");

ok(dualFn !== "", "ui_set_now_avatar_dual() still states both Now Playing layouts");
ok(
  cohostShowFn.includes("ui_set_now_avatar_dual(true)"),
  "showing the co-host moves the byline and lamp across",
);
ok(
  cohostHideFn.includes("ui_set_now_avatar_dual(false)"),
  "hiding the co-host moves the byline and lamp back",
);
ok(lampMove !== null, "the dual layout relocates live_lamp", "no `lv_obj_set_x(lamp, dual ? ...)` found");

const dualLampX = lampMove ? Number(lampMove[1]) : null;
const cohostWellRight =
  cohostWell?.align === "TOP_LEFT" && cohostWell.x !== null && cohostWell.w !== null
    ? cohostWell.x + cohostWell.w
    : null;
const cohostExclusive =
  dualLampX !== null && cohostWellRight !== null && dualLampX >= cohostWellRight;
ok(
  cohostExclusive,
  "the relocated live_lamp clears the co-host well",
  `lamp x=${dualLampX}, well ends at ${cohostWellRight}`,
);

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

      // The only other runtime-exclusive pair. The toggle that reveals the
      // co-host well is the one that relocates the lamp, so they are never
      // drawn together at these coordinates — and only while that coupling
      // still holds (see the derivation above).
      const cohostPair =
        (a.id === "live_lamp" && b.id === "now_avatar_2_well") ||
        (a.id === "now_avatar_2_well" && b.id === "live_lamp");
      if (cohostPair && cohostExclusive) continue;
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

const artworkWidgets = parseWidgets(screenPath(ROOT, "now"));
const artworkLayer = artworkWidgets.get("art_layers");
ok(
  artworkLayer?.x === 696 && artworkLayer.y === 80 && artworkLayer.w === 520 && artworkLayer.h === 520,
  "artwork effects container preserves the cover rectangle",
);
for (const name of ["art_in", "art_out"]) {
  const image = artworkWidgets.get(name);
  ok(
    image?.parentId === "art_layers" && image.nested,
    `${name} remains below the shared parent post-draw effects when raised to foreground`,
  );
  ok(
    image?.x === 0 && image.y === 0 && image.w === artworkLayer?.w && image.h === artworkLayer?.h,
    `${name} fills the effects container without changing the cover placement`,
  );
}

console.log(`  ${passed}/${passed + failed} screen-layout assertions passed`);
process.exit(failed === 0 ? 0 : 1);
