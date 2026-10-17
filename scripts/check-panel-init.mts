// The panel's init sequence, and the two ways it silently costs you an afternoon.
//
// THE HAZARD THIS EXISTS TO CATCH. `init_sequence` APPENDS to the sequence the
// chosen model already carries. It does not replace it. That is not documented in
// ESPHome's mipi_dsi docs in a way you will read before you need it, and it fails
// in the most expensive possible way: perfectly.
//
// Passing the vendor's own full panel sequence under `model: JC8012P4A1` sends
// 391 commands instead of 198. The duplicated register writes stall roughly nine
// seconds inside esp_lcd_panel_io_tx_param waiting on an ACK the panel no longer
// sends, which makes display setup take 12.8s against a 5s task watchdog. The
// result is an instant boot loop, on a device bolted to a wall, after a build
// that reported success. Measured on hardware, not predicted.
//
// The correct way to use a sequence that differs from the model's is
// `model: CUSTOM`, where the model contributes no default and `init_sequence`
// becomes the whole thing. That is the entire reason this file exists: to make
// the distinction something a machine checks rather than something a person has
// to already know.
//
// THE SECOND HAZARD, smaller but the same shape of trap: a delay entry in an
// init sequence is written `- delay 120`, and the docstring for map_sequence()
// says the number is in milliseconds. It is not optional to write the unit.
// `- delay 120` fails validation with `Unknown value ''` from the time-period
// parser, which describes neither the field nor the line, and neither does the
// surrounding YAML. Written as `- delay 120ms` it works.
//
// Neither of these needs ESPHome, a compiler or hardware. Both are decidable by
// reading the YAML, which is why they belong in the check suite.
//
// Run: npm run check:panel-init
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FIRMWARE = path.join(ROOT, "device", "firmware");

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

/** Every .yaml/.yml under a directory, skipping build output. */
function yamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".esphome" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(p));
    else if (/\.ya?ml$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = yamlFiles(FIRMWARE);
ok(files.length > 0, "found the firmware YAML to check", `${files.length} file(s)`);

/**
 * Every display entry in the firmware, with the model it names.
 *
 * Deliberately a scan rather than a schema walk. The failure this catches is
 * about a COMBINATION — a sequence next to a model that already has one — and a
 * parser that understood the schema would be one refactor away from not
 * reporting it. The `panel_include` substitution means the panel actually built
 * is not necessarily in any one file, so the check has to read what every file
 * says.
 *
 * Two shapes count, and both are in use here:
 *   - a top-level `display:` key, whose value may be `!include`d
 *   - a bare list whose entries carry `platform:` (panel.yaml, panel_vendor.yaml)
 */
interface DisplayEntry {
  file: string;
  model: string;
  hasInitSequence: boolean;
}

/** Lines belonging to a top-level `display:` key, or the whole file if it is a bare list. */
function displayLines(lines: string[]): string[] {
  const start = lines.findIndex((l) => /^display:/.test(l));
  if (start !== -1) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\S/.test(l));
    return end === -1 ? rest : rest.slice(0, end);
  }
  // A bare-list panel file: its first meaningful line starts a list entry.
  const first = lines.findIndex((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (first !== -1 && /^- /.test(lines[first].trim())) return lines.slice(first);
  return [];
}

const entries: DisplayEntry[] = [];
for (const file of files) {
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("#"));

  const body = displayLines(lines);
  if (body.length === 0) continue;

  let model = "";
  let hasInitSequence = false;

  for (const line of body) {
    const trimmed = line.trim();
    // A new list entry ends the previous one.
    if (trimmed.startsWith("- ")) {
      if (model) entries.push({ file: path.relative(ROOT, file), model, hasInitSequence });
      model = "";
      hasInitSequence = false;
      }
    const m = /^model:\s*"?([A-Za-z0-9_]+)"?\s*$/.exec(trimmed);
    if (m) model = m[1];
    if (/^init_sequence:/.test(trimmed)) hasInitSequence = true;
  }
  if (model) entries.push({ file: path.relative(ROOT, file), model, hasInitSequence });
}

ok(entries.length > 0, "found at least one display entry", `${entries.length} found`);

for (const e of entries) {
  const where = `${e.file} (model: ${e.model})`;

  // THE MAIN GATE.
  //
  // A model with a built-in sequence plus an `init_sequence` means append, not
  // replace, which is the boot loop. `CUSTOM` is the one model that contributes
  // nothing, so there appending is the whole thing and is exactly right.
  const modelHasDefault = e.model !== "CUSTOM";
  ok(
    !e.hasInitSequence || !modelHasDefault,
    `${where}: does not append to a model's built-in sequence`,
    e.hasInitSequence && modelHasDefault
      ? "init_sequence APPENDS — use `model: CUSTOM` to supply a whole sequence"
      : "",
  );

  // Every delay carries a unit, or the time-period parser fails with a message
  // that names neither the field nor the line.
  //
  // Checked per-file rather than per-display-entry, because the delays usually
  // are not in the display block at all: `init_sequence: !include`d files hold
  // them, so a per-entry scan sees an empty list and passes vacuously. That is
  // worse than not checking — a gate that reports success without looking.
}

// Any `- delay N` anywhere in the firmware YAML, wherever it lives.
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  for (const line of src.split("\n")) {
    const d = /^-\s*(delay\s+\S+)\s*$/.exec(line.trim());
    if (!d) continue;
    const value = d[1].replace(/^delay\s+/, "");
    ok(
      /^\d+(\.\d+)?(ns|us|µs|ms|s)$/.test(value),
      `${rel}: delay "${d[1]}" carries a unit`,
      `"${value}" is a bare number; map_sequence rejects it with "Unknown value ''"`,
    );
  }
}

// The panel file named by `panel_include` must exist. ESPHome resolves
// `!include ${panel_include}` while loading YAML — before command-line
// substitution overrides are applied — so a typo here is not reported as a typo.
const buildYaml = path.join(FIRMWARE, "builds", "subwave-jc8012p4a1.yaml");
if (fs.existsSync(buildYaml)) {
  const src = fs.readFileSync(buildYaml, "utf8");
  const m = /^  panel_include:\s*(\S+)\s*$/m.exec(src);
  if (m) {
    const target = path.join(FIRMWARE, "common", m[1]);
    ok(fs.existsSync(target), `panel_include '${m[1]}' resolves to a file that exists`);
  } else {
    ok(false, "panel_include substitution is present", "not found in the build YAML");
  }
}

// If a vendor sequence is present it must be the WHOLE vendor list, not a
// fragment — a truncated one sends a partial configuration and the panel comes
// up blank with nothing in the log, which is the exact failure this file was
// written after.
//
// There are two, because the vendor ships two different panels under nearly the
// same name. They are different drivers, not different tunings of one: the
// command lists diverge at index 7 and never resync.
const VENDOR_SEQUENCES: [string, number, number][] = [
  ["jc8012p4a1_init.yaml", 198, 2],
  ["jc8012p4a1_init_new.yaml", 204, 2],
];

for (const [name, wantCommands, wantDelays] of VENDOR_SEQUENCES) {
  const p = path.join(FIRMWARE, "common", name);
  if (!fs.existsSync(p)) {
    ok(false, `${name} exists`, "missing");
    continue;
  }
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const commands = lines.filter((l) => /^\s+- \[0x/.test(l));
  const delays = lines.filter((l) => /^\s+- delay/.test(l));
  ok(
    commands.length === wantCommands,
    `${name} has all ${wantCommands} commands`,
    `found ${commands.length}`,
  );
  ok(delays.length === wantDelays, `${name} carries its ${wantDelays} delays`, `found ${delays.length}`);
  // The command ESPHome's model omits, and the one the two revisions differ on
  // at index 7. Both matter for different reasons and neither is obvious.
  ok(
    name.endsWith("_new.yaml") || commands.some((l) => l.includes("0x4A")),
    `${name} includes 0x4A`,
    "the command ESPHome's model omits, which is why CUSTOM exists",
  );
}

// The two panel variants must not be silently interchangeable: they differ in
// command list AND pixel clock, and picking the wrong one produces a blank panel
// with no hint which way you guessed. Assert they actually differ.
const oldPanel = path.join(FIRMWARE, "common", "panel_vendor.yaml");
const newPanel = path.join(FIRMWARE, "common", "panel_vendor_new.yaml");
if (fs.existsSync(oldPanel) && fs.existsSync(newPanel)) {
  const a = fs.readFileSync(oldPanel, "utf8");
  const b = fs.readFileSync(newPanel, "utf8");
  ok(a.includes("jc8012p4a1_init.yaml"), "old-revision panel includes the old sequence");
  ok(b.includes("jc8012p4a1_init_new.yaml"), "new-revision panel includes the new sequence");
  ok(/pclk_frequency:\s*60MHz/.test(a), "old-revision panel keeps the 60 MHz clock");
  ok(/pclk_frequency:\s*70MHz/.test(b), "new-revision panel uses the 70 MHz clock");
  ok(/vsync_back_porch:\s*10/.test(b), "new-revision panel uses vsync back porch 10");
}

console.log(`  ${passed}/${passed + failed} panel-init assertions passed`);
process.exit(failed === 0 ? 0 : 1);
