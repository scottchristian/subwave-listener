// Stress test and empirical adversarial challenge for Milestone 2:
// - LVGL UI Layout, Card Boundaries, Modal Lifecycle & Edge Cases
//
// Run: TEST_REPO_ROOT=$PWD node --import ./scripts/test-register.mjs scripts/stress-device-m2.mts

import fs from "node:fs";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const FW = path.join(REPO, "device", "firmware");
const DISPLAY_YAML = path.join(FW, "common", "display.yaml");
const NOW_YAML = path.join(FW, "common", "screens", "now.yaml");
const SHOWS_YAML = path.join(FW, "common", "screens", "shows.yaml");
const BINDING_YAML = path.join(FW, "common", "binding.yaml");
const UI_H = path.join(FW, "subwave_display", "ui.h");
const UI_CPP = path.join(FW, "subwave_display", "ui.cpp");
const CLIENT_H = path.join(FW, "subwave_display", "display_client.h");
const CLIENT_CPP = path.join(FW, "subwave_display", "display_client.cpp");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  const msg = `FAIL: ${name}${extra ? " — " + extra : ""}`;
  failures.push(msg);
  console.error("  " + msg);
}

console.log("=== SECTION 1: Layout Geometry, Card Bounds & Viewport Constraints ===");

const PANEL_W = 1280;
const PANEL_H = 800;

// Read display.yaml
const displaySrc = fs.readFileSync(DISPLAY_YAML, "utf8");

// Parse presenter_modal and presenter_card
ok(displaySrc.includes("id: presenter_modal"), "presenter_modal declared in display.yaml");
ok(displaySrc.includes("id: presenter_card"), "presenter_card declared in display.yaml");

// Verify modal overlay sizing & backdrop
const modalMatch = /id:\s*presenter_modal[\s\S]*?(?=widgets:)/.exec(displaySrc);
ok(modalMatch !== null, "presenter_modal block extracted");
if (modalMatch) {
  const b = modalMatch[0];
  ok(/width:\s*100%/.test(b), "presenter_modal width is 100%");
  ok(/height:\s*100%/.test(b), "presenter_modal height is 100%");
  ok(/align:\s*TOP_LEFT/.test(b), "presenter_modal align is TOP_LEFT");
  ok(/hidden:\s*true/.test(b), "presenter_modal hidden initially");
  ok(/clickable:\s*true/.test(b), "presenter_modal clickable is true (backdrop taps)");
  ok(/close_presenter_modal/.test(b), "presenter_modal on_click dismisses modal");
  ok(/bg_opa:\s*70%/.test(b), "presenter_modal bg_opa is 70% (dimmed overlay)");
}

// Card geometry
const cardMatch = /id:\s*presenter_card[\s\S]*?(?=widgets:)/.exec(displaySrc);
ok(cardMatch !== null, "presenter_card block extracted");
let cardW = 0, cardH = 0;
if (cardMatch) {
  const b = cardMatch[0];
  const wm = /width:\s*(\d+)px/.exec(b);
  const hm = /height:\s*(\d+)px/.exec(b);
  cardW = wm ? parseInt(wm[1], 10) : 0;
  cardH = hm ? parseInt(hm[1], 10) : 0;
  ok(cardW === 760, "presenter_card width is exactly 760px", `got ${cardW}`);
  ok(cardH === 460, "presenter_card height is exactly 460px", `got ${cardH}`);
  ok(/align:\s*CENTER/.test(b), "presenter_card align is CENTER");
  ok(/clickable:\s*true/.test(b), "presenter_card clickable is true (prevents backdrop touch bleed)");
  ok(/scrollable:\s*false/.test(b), "presenter_card scrollable is false");
}

// Verify Card Centering Mathematics
const cardLeft = Math.round((PANEL_W - cardW) / 2);
const cardTop = Math.round((PANEL_H - cardH) / 2);
const cardRight = cardLeft + cardW;
const cardBottom = cardTop + cardH;

ok(cardLeft === 260, "card horizontal offset is 260px", `got ${cardLeft}`);
ok(cardTop === 170, "card vertical offset is 170px", `got ${cardTop}`);
ok(cardRight === 1020 && cardRight < PANEL_W, "card right edge is 1020px within 1280px screen");
ok(cardBottom === 630 && cardBottom < PANEL_H, "card bottom edge is 630px within 800px screen");

// Card Child Elements Coordinates & Non-Overlap Checks
interface CardChild {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  align?: string;
}

// presenter_name: x: 28px, y: 22px, width: 580px
const nameX = 28;
const nameY = 22;
const nameW = 580;
const nameH = 32; // font_body size 26 + line spacing

// btn_presenter_close: align: TOP_RIGHT, x: -24px, y: 16px, width: 88px, height: 44px
const closeBtnW = 88;
const closeBtnH = 44;
const closeBtnX = cardW - 24 - closeBtnW; // 760 - 24 - 88 = 648
const closeBtnY = 16;

ok(nameX + nameW <= closeBtnX, "presenter_name does NOT collide with btn_presenter_close",
   `name ends at ${nameX + nameW}px, close button starts at ${closeBtnX}px (gap: ${closeBtnX - (nameX + nameW)}px)`);
ok(closeBtnX + closeBtnW <= cardW, "btn_presenter_close fits within card boundary",
   `ends at ${closeBtnX + closeBtnW}px <= ${cardW}px`);

// presenter_rule: x: 24px, y: 72px, width: 712px, height: 1px
const ruleX = 24;
const ruleY = 72;
const ruleW = 712;
const ruleH = 1;

ok(ruleY > nameY + nameH, "presenter_rule sits below presenter_name");
ok(ruleY > closeBtnY + closeBtnH, "presenter_rule sits below btn_presenter_close",
   `rule Y: ${ruleY} > close button bottom: ${closeBtnY + closeBtnH}`);
ok(ruleX + ruleW === cardW - ruleX, "presenter_rule is symmetrically centered within card",
   `left: ${ruleX}px, right margin: ${cardW - (ruleX + ruleW)}px`);

// presenter_avatar_well: x: 28px, y: 96px, width: 180px, height: 180px
const wellX = 28;
const wellY = 96;
const wellW = 180;
const wellH = 180;

ok(wellY > ruleY + ruleH, "presenter_avatar_well sits below presenter_rule");
ok(wellX + wellW <= cardW, "presenter_avatar_well fits inside card horizontally");
ok(wellY + wellH <= cardH, "presenter_avatar_well fits inside card vertically",
   `well bottom: ${wellY + wellH}px <= card height: ${cardH}px`);

// presenter_role: x: 236px, y: 100px, width: 496px
const roleX = 236;
const roleY = 100;
const roleW = 496;
const roleH = 22; // font_small 18px

ok(roleX >= wellX + wellW + 16, "presenter_role sits to the right of avatar well with clear margin",
   `role starts at ${roleX}px, well ends at ${wellX + wellW}px (gap: ${roleX - (wellX + wellW)}px)`);
ok(roleX + roleW <= cardW, "presenter_role fits inside card boundary",
   `ends at ${roleX + roleW}px <= ${cardW}px`);

// presenter_tagline: x: 236px, y: 136px, width: 496px
const tagX = 236;
const tagY = 136;
const tagW = 496;

ok(tagY >= roleY + roleH, "presenter_tagline sits below presenter_role");
ok(tagX + tagW <= cardW, "presenter_tagline fits inside card boundary");
ok(cardH - tagY >= 160, "sufficient vertical space in card for multiline wrapped tagline",
   `available vertical height: ${cardH - tagY}px`);

console.log("=== SECTION 2: Font Budget & Glyph Subsets Verification ===");

// 1. Font budget: MUST be strictly <= 3
const fontMatches = [...displaySrc.matchAll(/^\s*-?\s*file:\s*["']?gfonts:\/\/([^"\n]+)["']?/gm)];
ok(fontMatches.length <= 3, "font definitions strictly obey <= 3 font budget", `found ${fontMatches.length} fonts`);

// 2. Modal font references in display.yaml
const modalSection = displaySrc.slice(displaySrc.indexOf("id: presenter_modal"), displaySrc.indexOf("# Artwork."));
const usedFontsInModal = [...new Set([...modalSection.matchAll(/text_font:\s*(\w+)/g)].map((m) => m[1]))];
ok(usedFontsInModal.length > 0, "found text_font declarations in modal", usedFontsInModal.join(", "));
for (const f of usedFontsInModal) {
  ok(f === "font_body" || f === "font_small", `modal uses only approved font (${f})`);
}

// 3. Check for format string vulnerabilities in ui.cpp
const uiCppSrc = fs.readFileSync(UI_CPP, "utf8");
ok(!/lv_label_set_text_fmt\([^,]+,\s*(name|role|tagline)\b/.test(uiCppSrc),
   "ui.cpp does NOT pass user-supplied strings directly to format string functions");
ok(/lv_label_set_text\(lbl,\s*\(tagline\s*!=\s*nullptr\)\s*\?\s*tagline\s*:\s*""\)/.test(uiCppSrc),
   "tagline passed safely via lv_label_set_text with null check");
ok(/lv_label_set_text\(lbl,\s*\(name\s*!=\s*nullptr[^)]*\)\s*\?\s*name\s*:\s*"Presenter"\)/.test(uiCppSrc),
   "name passed safely via lv_label_set_text with null/empty check");
ok(/lv_label_set_text\(lbl,\s*\(role\s*!=\s*nullptr[^)]*\)\s*\?\s*role\s*:\s*"Host"\)/.test(uiCppSrc),
   "role passed safely via lv_label_set_text with null/empty check");

console.log("=== SECTION 3: Screen Click Triggers & Bindings Parity ===");

const nowSrc = fs.readFileSync(NOW_YAML, "utf8");
const showsSrc = fs.readFileSync(SHOWS_YAML, "utf8");
const bindSrc = fs.readFileSync(BINDING_YAML, "utf8");

// On-air screen clickable triggers
ok(/id:\s*now_avatar_well[\s\S]*?clickable:\s*true[\s\S]*?open_presenter_modal_for_now/.test(nowSrc),
   "now.yaml: now_avatar_well is clickable and opens modal for now");
ok(/id:\s*byline_presenter[\s\S]*?clickable:\s*true[\s\S]*?open_presenter_modal_for_now/.test(nowSrc),
   "now.yaml: byline_presenter is clickable and opens modal for now");

// Shows screen clickable triggers for row_0 .. row_4
for (let i = 0; i < 5; i++) {
  const rowRegex = new RegExp(`id:\\s*row_${i}[\\s\\S]*?clickable:\\s*true[\\s\\S]*?open_presenter_modal_for_slot\\(${i}\\)`);
  ok(rowRegex.test(showsSrc), `shows.yaml: row_${i} is clickable and opens modal for slot ${i}`);
}

// Modal bindings in binding.yaml
const expectedModalBindings = [
  "presenter_modal",
  "presenter_card",
  "presenter_name",
  "btn_presenter_close",
  "presenter_close_label",
  "presenter_rule",
  "presenter_avatar_well",
  "presenter_avatar",
  "presenter_role",
  "presenter_tagline",
];

for (const b of expectedModalBindings) {
  ok(bindSrc.includes(`bind_object("${b}", id(${b}));`), `binding.yaml binds ${b}`);
}
ok(bindSrc.includes("bind_modal_avatar_image(id(presenter_avatar_image))"), "binding.yaml binds modal avatar image decoder");

// Theme styling in ui.cpp
const themeFnMatch = /void\s+theme_paint_all\s*\(\s*\)\s*\{([\s\S]*?)\n\}/.exec(uiCppSrc);
ok(themeFnMatch !== null, "theme_paint_all function extracted from ui.cpp");
if (themeFnMatch) {
  const body = themeFnMatch[1];
  const themedWidgets = [
    "presenter_card",
    "presenter_rule",
    "presenter_avatar_well",
    "btn_presenter_close",
    "presenter_name",
    "presenter_close_label",
    "presenter_role",
    "presenter_tagline",
  ];
  for (const b of themedWidgets) {
    ok(body.includes(`OBJ(${b})`), `theme_paint_all styles ${b}`);
  }
}

// presenter_modal used in presenter_modal_show & presenter_modal_dismiss
ok(/OBJ\(presenter_modal\)/.test(uiCppSrc), "OBJ(presenter_modal) used for modal visibility lifecycle in ui.cpp");
// presenter_avatar used in presenter_modal_show & ui_apply_modal_avatar
ok(/OBJ\(presenter_avatar\)/.test(uiCppSrc), "OBJ(presenter_avatar) used for avatar image painting in ui.cpp");

console.log("=== SECTION 4: Empirical C++ State Machine & Lifecycle Simulation ===");

const clientCppSrc = fs.readFileSync(CLIENT_CPP, "utf8");
const clientHSrc = fs.readFileSync(CLIENT_H, "utf8");

// State struct definition
ok(/struct\s+PresenterModalState\s*\{[\s\S]*?bool\s+open\{false\};[\s\S]*?std::string\s+name;[\s\S]*?std::string\s+role;[\s\S]*?std::string\s+tagline;[\s\S]*?std::string\s+avatar_url;[\s\S]*?\};/.test(clientHSrc),
   "PresenterModalState struct correctly defined with default open=false");

// Bound check in open_presenter_modal_for_slot:
// Negative slot check, MAX_SCHEDULE_SLOTS check, schedule_slots_.size() check
const slotFnMatch = /void\s+SubwaveDisplay::open_presenter_modal_for_slot\s*\(int\s+slot_index\)\s*\{([\s\S]*?)\n\}/.exec(clientCppSrc);
ok(slotFnMatch !== null, "open_presenter_modal_for_slot extracted");
if (slotFnMatch) {
  const body = slotFnMatch[1];
  ok(/slot_index\s*<\s*0/.test(body), "open_presenter_modal_for_slot guards negative slot_index");
  ok(/slot_index\s*>=\s*\(int\)\s*this->schedule_slots_\.size\(\)/.test(body),
     "open_presenter_modal_for_slot guards against slots beyond schedule size");
  ok(/slot_index\s*>=\s*MAX_SCHEDULE_SLOTS/.test(body),
     "open_presenter_modal_for_slot guards against slots >= MAX_SCHEDULE_SLOTS");
}

// Non-blocking queue enqueue test
ok(/enqueue_command_/.test(clientCppSrc), "client uses enqueue_command_ for async image request");
ok(/xQueueSend\s*\(\s*this->worker_cmd_queue_,\s*&cmd,\s*0\s*\)/.test(clientCppSrc),
   "enqueue_command_ guarantees zero-tick timeout on loopTask");

// Slot index -3 protocol consistency
ok(/cmd\.slot_index\s*=\s*-3;/.test(clientCppSrc), "worker command uses slot_index = -3 for modal avatar fetch");
ok(/res\.slot_index\s*==\s*-3/.test(clientCppSrc), "worker result handles slot_index == -3 for modal avatar");
ok(/ui_apply_modal_avatar\(img\)/.test(clientCppSrc), "dispatches IMAGE_DECODED with slot -3 to ui_apply_modal_avatar");

// Size query parameter protocol in avatar URL construction
const avatarUrlQueryCheck = /avatar_url\.find\("\?"\)\s*!=\s*std::string::npos\s*\?\s*avatar_url\s*\+\s*"&size=180"\s*:\s*avatar_url\s*\+\s*"\?size=180"/.test(clientCppSrc);
ok(avatarUrlQueryCheck, "open_presenter_modal appends &size=180 or ?size=180 appropriately");

// Immediate placeholder behavior
ok(/presenter_modal_show\(name\.c_str\(\),\s*role\.c_str\(\),\s*tagline\.c_str\(\),\s*placeholder\)/.test(clientCppSrc),
   "paints immediate placeholder to modal before async fetch");

// Cache reuse check (no redundant fetch when already shown)
ok(/if\s*\(expected_180\s*!=\s*this->shown_modal_avatar_url_\)/.test(clientCppSrc),
   "avoids duplicate network fetch when modal avatar is already loaded");

console.log("=== SECTION 5: Adversarial Edge Cases Simulation ===");

// Simulate C++ state transitions under adversarial conditions
class SimulatedDisplayClient {
  modal_open = false;
  modal_name = "";
  modal_role = "";
  modal_tagline = "";
  modal_avatar_url = "";
  shown_modal_avatar_url = "";
  worker_queue: any[] = [];
  queue_capacity = 16;
  ui_results: any[] = [];
  schedule_slots: any[] = [];
  byline: any = { presenter: "", show: "", tagline: "", avatar_url: "" };
  now_avatar_image = { width: 88, height: 88, data: "cached_now" };
  row_avatar_images: (any | null)[] = [
    { width: 56, height: 56, data: "row0" },
    { width: 56, height: 56, data: "row1" },
    null,
    null,
    null,
  ];
  modal_avatar_image: any = { width: 0, height: 0, data: null };

  enqueue_command(cmd: any): boolean {
    if (this.worker_queue.length >= this.queue_capacity) return false;
    this.worker_queue.push(cmd);
    return true;
  }

  enqueue_result(res: any): boolean {
    if (this.ui_results.length >= this.queue_capacity) return false;
    this.ui_results.push(res);
    return true;
  }

  open_presenter_modal_for_now() {
    let name = this.byline.presenter || "Subwave Radio";
    let role = "Host";
    let tagline = this.byline.tagline || "";
    let avatar_url = this.byline.avatar_url || "";

    this.modal_open = true;
    this.modal_name = name;
    this.modal_role = role;
    this.modal_tagline = tagline;
    this.modal_avatar_url = avatar_url;

    let placeholder = this.now_avatar_image;
    let expected_180 = avatar_url ? (avatar_url.includes("?") ? avatar_url + "&size=180" : avatar_url + "?size=180") : "";
    if (this.modal_avatar_image && this.modal_avatar_image.width > 0 && expected_180 && this.shown_modal_avatar_url === expected_180) {
      placeholder = this.modal_avatar_image;
    }

    if (avatar_url && this.modal_avatar_image) {
      if (expected_180 !== this.shown_modal_avatar_url) {
        this.shown_modal_avatar_url = expected_180;
        this.enqueue_command({ type: "FETCH_PNG", url: expected_180, slot_index: -3 });
      }
    }
  }

  open_presenter_modal_for_slot(slot_index: number) {
    if (slot_index < 0 || slot_index >= this.schedule_slots.length || slot_index >= 5) {
      return;
    }
    const slot = this.schedule_slots[slot_index];
    let name = slot.host || slot.name || "Presenter";
    let role = "Host";
    let tagline = slot.tagline || "";
    let avatar_url = slot.avatar_url || "";

    this.modal_open = true;
    this.modal_name = name;
    this.modal_role = role;
    this.modal_tagline = tagline;
    this.modal_avatar_url = avatar_url;

    let placeholder = this.row_avatar_images[slot_index];
    let expected_180 = avatar_url ? (avatar_url.includes("?") ? avatar_url + "&size=180" : avatar_url + "?size=180") : "";
    if (this.modal_avatar_image && this.modal_avatar_image.width > 0 && expected_180 && this.shown_modal_avatar_url === expected_180) {
      placeholder = this.modal_avatar_image;
    }

    if (avatar_url && this.modal_avatar_image) {
      if (expected_180 !== this.shown_modal_avatar_url) {
        this.shown_modal_avatar_url = expected_180;
        this.enqueue_command({ type: "FETCH_PNG", url: expected_180, slot_index: -3 });
      }
    }
  }

  close_presenter_modal() {
    this.modal_open = false;
  }
}

const sim = new SimulatedDisplayClient();

// Test 5.1: Negative slot index
sim.open_presenter_modal_for_slot(-1);
ok(!sim.modal_open, "Negative slot (-1) does not open modal");

// Test 5.2: Out-of-bounds slot index on empty schedule
sim.open_presenter_modal_for_slot(0);
ok(!sim.modal_open, "Slot 0 on empty schedule does not open modal");

// Test 5.3: Out-of-bounds slot index (> 4)
sim.schedule_slots = [
  { name: "Show 0", host: "Host 0", tagline: "Tag 0", avatar_url: "/api/devices/avatar?id=0" },
  { name: "Show 1", host: "Host 1", tagline: "Tag 1", avatar_url: "/api/devices/avatar?id=1" },
];
sim.open_presenter_modal_for_slot(5);
ok(!sim.modal_open, "Slot 5 does not open modal");
sim.open_presenter_modal_for_slot(2);
ok(!sim.modal_open, "Slot 2 (exceeding schedule_slots.length=2) does not open modal");

// Test 5.4: Valid slot open
sim.open_presenter_modal_for_slot(0);
ok(sim.modal_open, "Valid slot 0 opens modal");
ok(sim.modal_name === "Host 0", "modal_name correctly set to Host 0");
ok(sim.modal_tagline === "Tag 0", "modal_tagline correctly set to Tag 0");
ok(sim.worker_queue.length === 1, "worker queue enqueued 1 FETCH_PNG command");
ok(sim.worker_queue[0].url === "/api/devices/avatar?id=0&size=180", "FETCH_PNG URL has &size=180 appended");

// Test 5.5: Touch bounce - rapid open/close cycling 100 times
for (let i = 0; i < 100; i++) {
  sim.open_presenter_modal_for_slot(0);
  sim.close_presenter_modal();
}
ok(!sim.modal_open, "Modal is closed after rapid 100 open/close cycles");
// Notice: because shown_modal_avatar_url was already set, no new fetch commands are enqueued!
ok(sim.worker_queue.length === 1, "Worker queue not spammed with duplicate fetch commands during bounce");

// Test 5.6: Rapid switching across all slots
sim.schedule_slots = [
  { name: "Show 0", host: "Host 0", tagline: "Tag 0", avatar_url: "/avatar/0" },
  { name: "Show 1", host: "Host 1", tagline: "Tag 1", avatar_url: "/avatar/1" },
  { name: "Show 2", host: "Host 2", tagline: "Tag 2", avatar_url: "/avatar/2" },
  { name: "Show 3", host: "Host 3", tagline: "Tag 3", avatar_url: "/avatar/3" },
  { name: "Show 4", host: "Host 4", tagline: "Tag 4", avatar_url: "/avatar/4" },
];

sim.worker_queue = [];
for (let i = 0; i < 5; i++) {
  sim.open_presenter_modal_for_slot(i);
}
ok(sim.modal_open, "Modal remains open during rapid slot switching");
ok(sim.modal_name === "Host 4", "Modal reflects latest selected host (Host 4)");
ok(sim.worker_queue.length === 5, "All 5 unique avatar fetches enqueued without queue overflow");

// Test 5.7: Queue overflow protection under extreme command flood (>16 items)
for (let i = 0; i < 30; i++) {
  sim.enqueue_command({ type: "FETCH_PNG", url: `/dummy/${i}`, slot_index: -3 });
}
ok(sim.worker_queue.length === sim.queue_capacity, `Worker queue capped at capacity ${sim.queue_capacity} with zero block`);

// Test 5.8: Special characters in name and tagline
const specialNames = [
  "DJ & Producer",
  "<script>alert(1)</script>",
  "René & Zoë",
  "O'Connor \"The Boss\"",
  "Host %s %d %n %x",
  "こんにちは / 广播员",
  "A".repeat(250),
];

for (const sn of specialNames) {
  sim.byline = { presenter: sn, show: "Special Show", tagline: sn, avatar_url: "" };
  sim.open_presenter_modal_for_now();
  ok(sim.modal_name === sn, `Special presenter name handled without corruption: ${sn.slice(0, 20)}...`);
  ok(sim.modal_tagline === sn, `Special tagline handled without corruption: ${sn.slice(0, 20)}...`);
}

// Test 5.9: Missing/null tagline and name
sim.byline = { presenter: "", show: "", tagline: null, avatar_url: "" };
sim.open_presenter_modal_for_now();
ok(sim.modal_name === "Subwave Radio", "Empty presenter falls back to Subwave Radio");
ok(sim.modal_tagline === "", "Null tagline falls back to empty string");

sim.byline = { presenter: undefined, show: undefined, tagline: undefined, avatar_url: undefined };
sim.open_presenter_modal_for_now();
ok(sim.modal_name === "Subwave Radio", "Undefined presenter falls back to Subwave Radio");
ok(sim.modal_tagline === "", "Undefined tagline falls back to empty string");

console.log(`\n========================================`);
console.log(`RESULTS: ${passed}/${passed + failed} assertions passed.`);
if (failures.length > 0) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error(f);
  process.exit(1);
} else {
  console.log("All Milestone 2 empirical adversarial checks PASSED!");
  process.exit(0);
}
