// The widget bindings, and why they can drift silently.
//
// THE HAZARD THIS EXISTS TO CATCH. ESPHome generates every LVGL widget id as a
// `static` object in its own main.cpp, so a component's C++ cannot name it — the
// pointers are handed over at boot by common/binding.yaml and looked up by name
// in subwave_display/ui.cpp. That design is deliberate (a positional table would
// paint one label's text into another widget with nothing in the log) but it has
// a cost: the list of widgets now exists in TWO places, and nothing in a C++
// build will tell you when they disagree.
//
// The failure is silent and it is on a wall. A widget added to a screen and not
// bound leaves a label that never changes — and the only symptom is that one
// label is wrong, weeks later, on a screen somebody has to walk up to. A widget
// bound but renamed leaves a lookup that logs its own name at boot, which is at
// least visible; this catches the first case, which is the quiet one.
//
// WHAT IS CHECKED, in the order a mistake would actually be made:
//   1. every OBJ(name) used in ui.cpp is bound in binding.yaml
//   2. every id() referenced in binding.yaml is a real widget or global in the
//      screen YAML — a typo there binds null and looks like a missing widget
//   3. the count is what the boot log will claim
//
// This needs no ESPHome, no compiler and no hardware: it is file-versus-file
// consistency, which is why it belongs in the check suite rather than in the
// bring-up checklist.
//
// Run: npm run check:firmware-bindings
import fs from "node:fs";
import path from "node:path";

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

const FW = path.join(process.cwd(), "device", "firmware");
const UI_CPP = path.join(FW, "subwave_display", "ui.cpp");
const BINDING = path.join(FW, "common", "binding.yaml");

if (!fs.existsSync(UI_CPP) || !fs.existsSync(BINDING)) {
  console.log("  note  firmware sources not present — the bindings check did not run.");
  console.log(`  ${passed}/${passed + failed} firmware-binding assertions passed`);
  process.exit(0);
}

// Macro DEFINITIONS look exactly like uses — `#define OBJ(name)` contains the
// text `OBJ(name)`. Scanning the whole file therefore reports a widget called
// "name", which does not exist. Definitions are stripped before the scan.
const uiSrc = fs
  .readFileSync(UI_CPP, "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#define"))
  .join("\n");
const bindSrc = fs.readFileSync(BINDING, "utf8");

// ---- 1. what the C++ asks for ------------------------------------------
const usedObjects = new Set<string>();
for (const m of uiSrc.matchAll(/\bOBJ\((\w+)\)/g)) usedObjects.add(m[1]);
for (const m of uiSrc.matchAll(/\bINT\((\w+)\)/g)) usedObjects.add(m[1]);
for (const m of uiSrc.matchAll(/\bBOOL\((\w+)\)/g)) usedObjects.add(m[1]);
for (const m of uiSrc.matchAll(/\bU32\((\w+)\)/g)) usedObjects.add(m[1]);

// ---- 2. what the YAML provides -----------------------------------------
const boundObjects = new Set<string>();
for (const m of bindSrc.matchAll(/bind_object\("(\w+)"/g)) boundObjects.add(m[1]);
const boundScalars = new Set<string>();
for (const kind of ["bind_int", "bind_bool", "bind_uint32"]) {
  for (const m of bindSrc.matchAll(new RegExp(`${kind}\\("(\\w+)"`, "g"))) boundScalars.add(m[1]);
}
const boundAll = new Set([...boundObjects, ...boundScalars]);

ok(usedObjects.size > 0, `ui.cpp asks for ${usedObjects.size} bound name(s)`);
ok(boundAll.size > 0, `binding.yaml provides ${boundAll.size}`);

const missing = [...usedObjects].filter((n) => !boundAll.has(n)).sort();
ok(
  missing.length === 0,
  "every name ui.cpp looks up is bound — a missing one is a label that never updates",
  missing.join(", "),
);

// The other direction matters too, and for a different reason: a name bound in
// YAML that ui.cpp never asks for is usually a widget that was renamed on one
// side only, and it would be silently dead rather than silently broken.
const unused = [...boundAll].filter((n) => !usedObjects.has(n)).sort();
ok(
  unused.length === 0,
  "nothing is bound that ui.cpp never reads — that is a rename applied to one side only",
  unused.join(", "),
);

// ---- 3. the ids in binding.yaml are real --------------------------------
// A typo here binds null, and a null is indistinguishable from an unbound name
// at runtime — so it is checked against the YAML the widgets are declared in.
const screensDir = FW;
const declared = new Set<string>();
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // .esphome holds the build output, not the source, and is ~1GB.
    if (entry.isDirectory()) {
      if (entry.name === ".esphome") continue;
      walk(full);
    }
    else if (entry.name.endsWith(".yaml")) {
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/^\s*-?\s*id:\s*(\w+)\s*$/gm)) declared.add(m[1]);
      for (const m of src.matchAll(/[{,]\s*id:\s*(\w+)\s*[,}]/g)) declared.add(m[1]);
    }
  }
};
walk(screensDir);

ok(declared.size > 0, `${declared.size} id(s) declared across the screen YAML`);

const referenced = new Set<string>();
for (const m of bindSrc.matchAll(/\bid\((\w+)\)/g)) referenced.add(m[1]);

const phantom = [...referenced].filter((n) => !declared.has(n)).sort();
ok(
  phantom.length === 0,
  "every id() in binding.yaml is actually declared in the screen YAML",
  phantom.join(", "),
);

// ---- 4. the count the boot log will claim -------------------------------
// `Bound N object(s).` is the cheapest diagnostic the screen has. If the two
// numbers can disagree, the line is worthless when it is needed.
const boundCount = (bindSrc.match(/\bbind_(?:object|int|bool|uint32)\(/g) || []).length;
ok(
  boundCount === boundAll.size,
  "the binder registers exactly what it declares (no duplicate names)",
  `${boundCount} calls, ${boundAll.size} distinct names`,
);

console.log(`  ${passed}/${passed + failed} firmware-binding assertions passed`);
if (failed > 0) process.exit(1);
