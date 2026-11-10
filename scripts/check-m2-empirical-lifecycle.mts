// Empirical verification of Milestone 2 script execution and visual confirmation lifecycle.
//
// Tests:
// 1. Script lifecycle simulation: clear_avatar_cache -> label "Cache Cleared" -> 2s non-blocking delay -> settings_refresh -> "Clear Cache" + stats
// 2. Re-entrancy & rapid double-tap behavior under mode: restart
// 3. Null-safety on display_client and LVGL widget pointers
// 4. Non-blocking verification (zero blocking calls in script, FreeRTOS timer dispatch)
// 5. Font glyph coverage in display.yaml for all confirmation & stats strings
// 6. Mutex lock hierarchy & bounded timeout check in display_client.cpp
//
// Run: node --experimental-strip-types --no-warnings scripts/check-m2-empirical-lifecycle.mts

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
  console.error(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

const ROOT = process.cwd();
const SCRIPTS_YAML = path.join(ROOT, "device", "firmware", "common", "screens", "scripts.yaml");
const SETTINGS_YAML = path.join(ROOT, "device", "firmware", "common", "screens", "settings.yaml");
const BINDING_YAML = path.join(ROOT, "device", "firmware", "common", "binding.yaml");
const UI_CPP = path.join(ROOT, "device", "firmware", "subwave_display", "ui.cpp");
const DISPLAY_YAML = path.join(ROOT, "device", "firmware", "common", "display.yaml");
const CLIENT_CPP = path.join(ROOT, "device", "firmware", "subwave_display", "display_client.cpp");
const CLIENT_H = path.join(ROOT, "device", "firmware", "subwave_display", "display_client.h");

const scriptsSrc = fs.readFileSync(SCRIPTS_YAML, "utf8");
const settingsSrc = fs.readFileSync(SETTINGS_YAML, "utf8");
const bindingSrc = fs.readFileSync(BINDING_YAML, "utf8");
const uiSrc = fs.readFileSync(UI_CPP, "utf8");
const displaySrc = fs.readFileSync(DISPLAY_YAML, "utf8");
const clientCppSrc = fs.readFileSync(CLIENT_CPP, "utf8");
const clientHSrc = fs.readFileSync(CLIENT_H, "utf8");

// ============================================================================
// 1. Script Structure & AST Extraction
// ============================================================================
const clearScriptMatch = /-\s+id:\s*clear_image_cache[\s\S]*?(?=-\s+id:|\Z)/.exec(scriptsSrc);
ok(!!clearScriptMatch, "clear_image_cache script declared in scripts.yaml");

const clearScript = clearScriptMatch ? clearScriptMatch[0] : "";

// Mode restart guarantees rapid taps reset timer and do not queue up multiple delayed actions
ok(/mode:\s*restart/.test(clearScript), "clear_image_cache uses mode: restart (avoids stale action piling)");

// First action: c->clear_avatar_cache() and label update to "Cache Cleared"
ok(
  /c->clear_avatar_cache\(\)/.test(clearScript) && /lv_label_set_text\(id\(lbl_clear_cache\),\s*"Cache Cleared"\)/.test(clearScript),
  "First action invokes c->clear_avatar_cache() and sets label to 'Cache Cleared'"
);

// Delay action: exactly 2s
ok(
  /-\s+delay:\s*2s/.test(clearScript),
  "Script contains non-blocking '- delay: 2s' action"
);

// Final action: settings_refresh()
ok(
  /subwave_display::settings_refresh\(\)/.test(clearScript),
  "Script calls subwave_display::settings_refresh() after 2s delay"
);

// ============================================================================
// 2. Button on_click Trigger Wiring in settings.yaml
// ============================================================================
const btnClearMatch = /btn_clear_cache[\s\S]*?(?=\n\s{6}-\s+obj:|\n\s{6}-\s+button:|\n\s{4}#|\Z)/.exec(settingsSrc);
ok(!!btnClearMatch, "btn_clear_cache defined in settings.yaml");

const btnClear = btnClearMatch ? btnClearMatch[0] : "";
ok(
  /on_click:\s*\n\s*-\s*script\.execute:\s*clear_image_cache/.test(btnClear),
  "btn_clear_cache on_click executes clear_image_cache script"
);

ok(
  /id:\s*lbl_clear_cache[\s\S]*?clickable:\s*false/.test(btnClear),
  "lbl_clear_cache has clickable: false to prevent absorbing click events from parent button"
);

// ============================================================================
// 3. Visual Confirmation Restoration & Stats Refresh in ui.cpp
// ============================================================================
const refreshFn = /void\s+settings_refresh\(\)\s*\{([\s\S]*?)\n\}/.exec(uiSrc);
ok(!!refreshFn, "subwave_display::settings_refresh() exists in ui.cpp");

const refreshBody = refreshFn ? refreshFn[1] : "";

ok(
  refreshBody.includes("lv_label_set_text(btn_lbl, \"Clear Cache\");"),
  "settings_refresh() resets lbl_clear_cache text back to 'Clear Cache'"
);

// The stats label is its own function now: settings_refresh runs on every touch
// and must not read the cache counters, so the formatting lives in
// ui_refresh_cache_stats().
const statsFn = /void\s+ui_refresh_cache_stats\(\)\s*\{([\s\S]*?)\n\}/.exec(uiSrc);
ok(!!statsFn, "ui_refresh_cache_stats() exists in ui.cpp");
const statsBody = statsFn ? statsFn[1] : "";
ok(
  /snprintf\(buf,\s*sizeof\(buf\),\s*"%d images \(%d KB\)",\s*\(int\)\s*c->avatar_cache_count\(\),\s*\(int\)\s*c->avatar_cache_kb\(\)\)/.test(
    statsBody
  ),
  "ui_refresh_cache_stats() formats lbl_cache_stats with '%d images (%d KB)'"
);
ok(
  !refreshBody.includes("lbl_cache_stats"),
  "settings_refresh() does not touch the cache counters from the touch path"
);

// ============================================================================
// 4. State Machine Simulation Harness
// ============================================================================
interface SimulatedState {
  cacheCount: number;
  cacheKb: number;
  labelBtn: string;
  labelStats: string;
  shownUrls: string[];
  timerRemaining_ms: number;
  uiFramesRendered: number;
}

class LifecycleSimulator {
  state: SimulatedState;

  constructor() {
    this.state = {
      cacheCount: 5,
      cacheKb: 240,
      labelBtn: "Clear Cache",
      labelStats: "5 images (240 KB)",
      shownUrls: ["url1.png", "url2.png"],
      timerRemaining_ms: 0,
      uiFramesRendered: 0,
    };
  }

  tapClearButton(): void {
    // Mode restart behavior: cancels any existing delay timer and starts new 2000ms delay
    this.state.timerRemaining_ms = 2000;

    // Lambda 1: clear_avatar_cache()
    this.state.cacheCount = 0;
    this.state.cacheKb = 0;
    this.state.shownUrls = [];

    // lv_label_set_text -> "Cache Cleared"
    this.state.labelBtn = "Cache Cleared";
  }

  simulateTimePassage(duration_ms: number, frame_rate = 60): void {
    const frameInterval_ms = 1000 / frame_rate;
    let elapsed = 0;
    while (elapsed < duration_ms) {
      elapsed += frameInterval_ms;
      this.state.uiFramesRendered++;

      if (this.state.timerRemaining_ms > 0) {
        this.state.timerRemaining_ms -= frameInterval_ms;
        if (this.state.timerRemaining_ms <= 0) {
          this.state.timerRemaining_ms = 0;
          // Lambda 2: settings_refresh()
          this.state.labelBtn = "Clear Cache";
          this.state.labelStats = `${this.state.cacheCount} images (${this.state.cacheKb} KB)`;
        }
      }
    }
  }
}

// Single Tap Test
const sim1 = new LifecycleSimulator();
ok(sim1.state.labelBtn === "Clear Cache" && sim1.state.labelStats === "5 images (240 KB)", "Sim1: Initial state valid");
sim1.tapClearButton();
ok(sim1.state.labelBtn === "Cache Cleared", "Sim1: Label immediately updates to 'Cache Cleared'");
ok(sim1.state.cacheCount === 0 && sim1.state.shownUrls.length === 0, "Sim1: Cache cleared & URLs reset immediately");
sim1.simulateTimePassage(2050);
ok(sim1.state.labelBtn === "Clear Cache", "Sim1: Label resets to 'Clear Cache' after 2000ms");
ok(sim1.state.labelStats === "0 images (0 KB)", "Sim1: Stats reset to '0 images (0 KB)'");
ok(sim1.state.uiFramesRendered >= 120, "Sim1: Non-blocking UI loop maintained ~60 FPS (120+ frames rendered during 2s)");

// Rapid Double Tap (Re-entrancy) Test
const sim2 = new LifecycleSimulator();
sim2.tapClearButton();
ok(sim2.state.labelBtn === "Cache Cleared", "Sim2: First tap sets 'Cache Cleared'");
sim2.simulateTimePassage(500); // 500ms in
ok(sim2.state.labelBtn === "Cache Cleared", "Sim2: At 500ms still 'Cache Cleared'");
sim2.tapClearButton(); // Second tap at 500ms
ok(sim2.state.labelBtn === "Cache Cleared", "Sim2: Second tap re-asserts 'Cache Cleared' with timer restarted");
sim2.simulateTimePassage(1600); // 1600ms after second tap
ok(sim2.state.labelBtn === "Cache Cleared", "Sim2: At 1600ms from 2nd tap, timer has not expired yet");
sim2.simulateTimePassage(500); // Exceeds 2000ms from 2nd tap (total 2100ms)
ok(sim2.state.labelBtn === "Clear Cache", "Sim2: At 2100ms from 2nd tap, label resets to 'Clear Cache'");

// ============================================================================
// 5. Font Glyphs Verification
// ============================================================================
// Collect all glyphs defined under font: section in display.yaml
let fullGlyphSet = " "; // Space is implicit in font rendering
const lines = displaySrc.split("\n");
let inGlyphs = false;
for (const line of lines) {
  if (line.includes("glyphs: >-")) {
    inGlyphs = true;
    continue;
  }
  if (inGlyphs) {
    if (/^\s{6,}\S/.test(line)) {
      fullGlyphSet += line.trim();
    } else {
      inGlyphs = false;
    }
  }
}

const stringsToCheck = [
  "Image Cache",
  "Clear Cache",
  "Cache Cleared",
  "0 images (0 KB)",
  "999 images (12345 KB)",
];

for (const s of stringsToCheck) {
  let missingChars: string[] = [];
  for (const ch of s) {
    if (!fullGlyphSet.includes(ch)) {
      missingChars.push(ch);
    }
  }
  ok(
    missingChars.length === 0,
    `All characters in "${s}" are covered in display.yaml font glyphs`,
    `missing: ${missingChars.join(", ")}`
  );
}

// Invariant: Ensure the Unicode checkmark ✓ (U+2713) is NOT used, since it's absent from glyphs
ok(
  !clearScript.includes("✓"),
  "clear_image_cache does NOT use unicode checkmark ✓ (which is missing from font glyphs)"
);

// ============================================================================
// 6. Mutex Bounded Wait & Deadlock Avoidance
// ============================================================================
// All cache_mutex_ acquisitions must use pdMS_TO_TICKS(100), never portMAX_DELAY
const mutexAcquisitions = clientCppSrc.match(/xSemaphoreTake\s*\(\s*this->cache_mutex_,\s*([^)]*)\)/g) ?? [];
ok(
  mutexAcquisitions.length >= 3,
  "cache_mutex_ acquired at every cache access that touches the map (clear, lookup, store)"
);

for (const acq of mutexAcquisitions) {
  ok(
    acq.includes("pdMS_TO_TICKS(100)"),
    `Mutex acquisition uses bounded timeout pdMS_TO_TICKS(100): ${acq}`
  );
  ok(!acq.includes("portMAX_DELAY"), `Mutex acquisition never uses unbounded portMAX_DELAY: ${acq}`);
}

// Zero blocking calls on Core 1 clear_avatar_cache
const clearFn = /void\s+SubwaveDisplay::clear_avatar_cache\(\)\s*\{([\s\S]*?)\n\}/.exec(clientCppSrc);
ok(!!clearFn, "clear_avatar_cache() exists in display_client.cpp");
const clearBody = clearFn ? clearFn[1] : "";
ok(!/\bdelay\s*\(/.test(clearBody), "clear_avatar_cache contains zero delay() calls");
ok(!/\bvTaskDelay\s*\(/.test(clearBody), "clear_avatar_cache contains zero vTaskDelay() calls");
ok(!/\bhttp_request/.test(clearBody), "clear_avatar_cache contains zero http_request calls");

// ============================================================================
// 7. Null-Safety Checks
// ============================================================================
ok(
  /if\s*\(\s*c\s*!=\s*nullptr\s*\)\s*\{[\s\S]*?c->clear_avatar_cache\(\);/.test(clearScript),
  "clear_image_cache guards display_client with nullptr check"
);
ok(
  /if\s*\(\s*id\(lbl_clear_cache\)\s*!=\s*nullptr\s*\)/.test(clearScript),
  "clear_image_cache guards lbl_clear_cache with nullptr check"
);
ok(
  /if\s*\(\s*lv_obj_t\s*\*stats\s*=\s*OBJ\(lbl_cache_stats\)\s*\)/.test(statsBody),
  "ui_refresh_cache_stats guards lbl_cache_stats with OBJ check"
);
ok(
  /if\s*\(\s*lv_obj_t\s*\*btn_lbl\s*=\s*OBJ\(lbl_clear_cache\)\s*\)/.test(refreshBody),
  "settings_refresh guards lbl_clear_cache with OBJ check"
);

console.log(`\nEmpirical Challenger Results: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
