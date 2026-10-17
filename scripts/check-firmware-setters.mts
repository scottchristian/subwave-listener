// Setters in an external component's codegen that never reach main.cpp.
//
// THE BUG THIS EXISTS TO CATCH, and it is the worst one found in this firmware.
//
// ESPHome codegen is expression-based. `var.set_server_url(x)` builds a C++
// EXPRESSION and returns it; nothing is written into the generated main.cpp
// until that expression is passed to `cg.add()`. Calling a setter and discarding
// the return value therefore emits NO CODE AT ALL — and the build succeeds,
// because generating no code is not an error.
//
// subwave_display shipped that way for the device's entire identity:
//
//     var.set_server_url(config[CONF_SERVER_URL])
//     var.set_device_id(config[CONF_DEVICE_ID])
//     var.set_claim_token(config[CONF_CLAIM_TOKEN])
//     var.set_setup_ap_ssid(config[CONF_SETUP_AP_SSID])
//
// Four unwrapped calls. The screen therefore booted with an empty station URL,
// no device id, no claim token and no AP SSID, and could never have reached the
// station or claimed itself.
//
// WHY IT SURVIVED SO LONG, which is the part worth remembering: everything that
// was tested depends on none of those four. The panel rendered. The WiFi scan
// worked. The setup wizard answered on the access point. The device's whole
// visible behaviour was correct, and its entire identity was missing.
//
// WHICH IS WHY THIS IS NOT A STYLE CHECK. The failure is invisible in every
// other signal — the build is green, the firmware boots, the logs are clean, and
// the screen does exactly what it did before. The only place it shows up is the
// generated source, so that is where the check looks.
//
// The companion bug is in YAML rather than Python and is checked here too,
// because the two produce the same silent failure from opposite directions: an
// unquoted `${substitution}` has its value mangled by the YAML parser BEFORE
// codegen ever runs. `server_url: ${server_url}` became `https:` — the `//`
// started a comment — and nothing warned, because `https:` is still a valid URL.
//
// Run: npm run check:firmware-setters
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

/** Every python file that does ESPHome codegen. */
function pyFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === ".esphome") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pyFiles(p));
    else if (entry.name.endsWith(".py")) out.push(p);
  }
  return out;
}

const files = pyFiles(FIRMWARE);
ok(files.length > 0, "found firmware python to check", `${files.length} file(s)`);

// ---------------------------------------------------------------------------
// 1. Every setter is wrapped in cg.add().
// ---------------------------------------------------------------------------
/**
 * A statement of the form `<expr>.<setter>(...)` that is not inside cg.add().
 *
 * The line scan is on purpose rather than an AST walk: the mistake is a missing
 * wrapper, and a wrapper is visible on the same line as the call in every form
 * this codebase uses. A call split across lines would be missed, which is noted
 * rather than solved — the alternative is a parser dependency for a check that
 * has to run in CI without one.
 */
const CALL = /^\s*([A-Za-z_][\w.]*)\.(set_\w+)\(/;

// `seen` counts every setter call the scan looked at, wrapped or not. The
// sentinel asserts THAT — a check which silently stopped matching anything would
// otherwise pass forever, which is the failure mode of every regex-based check
// ever written.
let seen = 0;
let unwrapped = 0;

// Counted BEFORE the main scan, because the sentinel below has to know the check
// is still matching anything at all. A regex check that quietly stops matching
// reports success forever, and this is the cheapest defence against that.
let wrapped = 0;
for (const file of files) {
  for (const _m of fs.readFileSync(file, "utf8").matchAll(/\bcg\.add\([^)]*?\.\s*(set_\w+)\s*\(/g)) {
    void _m;
    wrapped++;
  }
}

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");

  // Track paren depth so a call written across several lines is judged by the
  // WHOLE expression rather than by the line the setter name happens to land on.
  //
  //   cg.add(                      <- depth becomes 1 here
  //       var.set_on_scan_script(   <- a line scan calls this unwrapped
  //           cg.RawExpression(...))
  //
  // A line-only check reports that as a bug, and a false positive on a check
  // this serious is worse than no check: the first one gets ignored.
  let depth = 0;
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "");
    const opensInsideCgAdd = /\bcg\.add\s*\(/.test(line);

    if (depth === 0 && !opensInsideCgAdd && !/^\s*#/.test(raw)) {
      const m = CALL.exec(line);
      if (m) {
        seen++;
        unwrapped++;
        ok(
          false,
          `${rel}:${i + 1} ${m[2]} is not wrapped in cg.add()`,
          "the expression is discarded and no code is generated",
        );
      }
    }

    for (const ch of line) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth < 0) depth = 0;
  });
}
ok(seen + wrapped > 0, "the scan still matches setter calls", `${seen + wrapped} total`);

// The specific four, named, so that deleting one of them entirely is caught too
// rather than merely reported as a smaller count.
const displayInit = fs.readFileSync(path.join(FIRMWARE, "subwave_display", "__init__.py"), "utf8");
for (const setter of ["set_server_url", "set_device_id", "set_claim_token", "set_setup_ap_ssid"]) {
  ok(
    new RegExp(`cg\\.add\\(\\s*var\\.${setter}\\(`).test(displayInit),
    `subwave_display wraps ${setter} in cg.add()`,
  );
}

// ---------------------------------------------------------------------------
// 2. Substituted values are quoted.
// ---------------------------------------------------------------------------
/**
 * `key: ${name}` unquoted, where the substituted text is a string.
 *
 * ESPHome substitutes before it parses, so a value containing `#`, `:` or `//`
 * is interpreted by the YAML parser as structure rather than as a string. The
 * result is still usually valid — a mangled URL passes `cv.url` — so the only
 * symptom is a device with the wrong identity and no error anywhere.
 *
 * Numeric substitutions are exempt: `artwork_size: ${artwork_size}` must stay a
 * bare number or `cv.int_range` rejects it.
 */
// A substitution whose declared value is a NUMBER is exempt: quoting it would
// hand `cv.int_range` the string "90" and fail validation, so leaving it bare is
// correct rather than careless. Read from the build file rather than hardcoded,
// so a substitution that changes type does not need this file changed too.
function walkYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".esphome" || entry.name === "__pycache__") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(p));
    else if (/\.ya?ml$/.test(entry.name)) out.push(p);
  }
  return out;
}

const BUILD_YAML = path.join(FIRMWARE, "builds", "subwave-jc8012p4a1.yaml");
const numericSubs = new Set<string>();
if (fs.existsSync(BUILD_YAML)) {
  const inSubs = fs.readFileSync(BUILD_YAML, "utf8").split("\n");
  let inBlock = false;
  for (const raw of inSubs) {
    if (/^substitutions:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(raw) && raw.trim()) break; // left the block
    const m = /^\s{2}([A-Za-z_]\w*):\s*(.+?)\s*$/.exec(raw);
    if (m && /^["']?\d+["']?$/.test(m[2])) numericSubs.add(m[1]);
  }
}
ok(numericSubs.size > 0, "read the numeric substitutions", `${[...numericSubs].join(", ")}`);

const yamlFiles = walkYaml(FIRMWARE);

let quotedCount = 0;
let seenSubs = 0;
for (const file of yamlFiles) {
  const rel = path.relative(ROOT, file);
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      if (/^\s*#/.test(raw)) return;
      // Matches quoted and unquoted, so the scan keeps seeing substitutions that
      // are already correct — otherwise a fixed tree reports "found none" and the
      // sentinel below stops meaning anything.
      const m = /^\s*([A-Za-z_][\w]*):\s*"?\s*\$\{\s*([A-Za-z_]\w*)\s*\}\s*"?\s*$/.exec(raw);
      if (!m) return;
      seenSubs++;
      if (numericSubs.has(m[2])) return;
      if (!/^\s*[A-Za-z_][\w]*:\s*"/.test(raw)) {
        quotedCount++;
        ok(
          false,
          `${rel}:${i + 1} ${m[1]} substitutes ${m[2]} unquoted`,
          "quote it — a value containing # : or // is parsed as YAML structure",
        );
      }
    });
}
ok(seenSubs > 0, "the scan still matches substitutions", `${seenSubs} total`);

// server_url is the one that bites, because it always contains `//`.
const buildYaml = fs.readFileSync(path.join(FIRMWARE, "builds", "subwave-jc8012p4a1.yaml"), "utf8");
ok(
  /^\s*server_url:\s*"\$\{server_url\}"\s*$/m.test(buildYaml),
  "server_url is quoted (an unquoted https://... loses its // to a YAML comment)",
);

console.log(`  ${passed}/${passed + failed} firmware-setter assertions passed`);
process.exit(failed === 0 ? 0 : 1);
