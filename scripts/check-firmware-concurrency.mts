// Empirical static & AST verification for Firmware Concurrency & Async Pipeline.
//
// Checks:
// 1. FreeRTOS queue full handling & 0-tick timeout
// 2. slot_index = -3 invariants & collision prevention
// 3. Stale worker results & modal state lifecycle
// 4. Decode failure graceful fallback
// 5. Zero blocking delay on Core 1 loop

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

function extractFunctionBody(src: string, signature: RegExp): string {
  const m = signature.exec(src);
  if (!m) return "";
  const open = src.indexOf("{", m.index);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}

const FW = path.join(process.cwd(), "device", "firmware", "subwave_display");
const CLIENT_H = path.join(FW, "display_client.h");
const CLIENT_CPP = path.join(FW, "display_client.cpp");
const UI_H = path.join(FW, "ui.h");
const UI_CPP = path.join(FW, "ui.cpp");
const DISPLAY_YAML = path.join(process.cwd(), "device", "firmware", "common", "display.yaml");

if (!fs.existsSync(CLIENT_H) || !fs.existsSync(CLIENT_CPP) || !fs.existsSync(UI_CPP)) {
  console.error("Firmware source files missing!");
  process.exit(1);
}

const clientH = fs.readFileSync(CLIENT_H, "utf8");
const clientCpp = fs.readFileSync(CLIENT_CPP, "utf8");
const uiH = fs.readFileSync(UI_H, "utf8");
const uiCpp = fs.readFileSync(UI_CPP, "utf8");
const displayYaml = fs.readFileSync(DISPLAY_YAML, "utf8");

// ============================================================================
// 1. Queue Full Handling & Zero Timeout
// ============================================================================
const enqueueCmdBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::enqueue_command_\s*\(/);
ok(
  enqueueCmdBody.includes("xQueueSend(this->worker_cmd_queue_, &cmd, 0)"),
  "enqueue_command_ uses strict 0 timeout (non-blocking for Core 1 UI loop)"
);
ok(
  enqueueCmdBody.includes("Worker queue full!") && enqueueCmdBody.includes("return false;"),
  "enqueue_command_ logs warning and returns false on queue full"
);

const enqueueResBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::enqueue_result_\s*\(/);
ok(
  enqueueResBody.includes("res->type == WorkerResultType::COVER_ART_READY ? portMAX_DELAY : 0") &&
    enqueueResBody.includes("xQueueSend(this->ui_result_queue_, &res, wait_ticks)"),
  "enqueue_result_ retains cover completions; other worker results use 0 timeout"
);
ok(
  enqueueResBody.includes("delete res;") && enqueueResBody.includes("UI result queue full!"),
  "enqueue_result_ deletes allocated WorkerResult on queue full (zero heap leak)"
);

// Verify loop drains result queue with timeout 0
const loopBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::loop\s*\(\s*\)/);
ok(
  /xQueueReceive\s*\(\s*this->ui_result_queue_,\s*&res,\s*0\s*\)\s*==\s*pdTRUE/.test(loopBody),
  "SubwaveDisplay::loop() drains ui_result_queue_ with 0 timeout"
);
ok(
  loopBody.includes("delete res;"),
  "SubwaveDisplay::loop() frees each processed WorkerResult on Core 1"
);

// ============================================================================
// 2. slot_index = -3 Invariant & Collision Prevention
// ============================================================================
// The untouched tap targets keep their no-argument entry points; the co-host
// tap targets have to say WHICH presenter they opened, so the start index moved
// into an `_at` variant and these two became one-line delegations.
const openNowBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::open_presenter_modal_for_now\s*\(\s*\)/);
ok(
  openNowBody.includes("this->open_presenter_modal_for_now_at(0);"),
  "open_presenter_modal_for_now opens the byline's first presenter"
);

const openNowAtBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::open_presenter_modal_for_now_at\s*\(/);
ok(
  openNowAtBody.includes("this->show_presenter_in_modal(") &&
    openNowAtBody.includes("start_index < this->presenter_modal_state_.presenters.size()"),
  "open_presenter_modal_for_now_at delegates to show_presenter_in_modal at the tapped index"
);

const openSlotBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::open_presenter_modal_for_slot\s*\(/);
ok(
  openSlotBody.includes("this->open_presenter_modal_for_slot_at(slot_index, 0);"),
  "open_presenter_modal_for_slot opens the row's first presenter"
);

const openSlotAtBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::open_presenter_modal_for_slot_at\s*\(/);
ok(
  openSlotAtBody.includes("this->show_presenter_in_modal(") &&
    openSlotAtBody.includes("start_index < this->presenter_modal_state_.presenters.size()"),
  "open_presenter_modal_for_slot_at delegates to show_presenter_in_modal at the tapped index"
);
ok(
  openSlotAtBody.includes("slot_index < 0 || slot_index >= (int) this->schedule_slots_.size() || slot_index >= MAX_SCHEDULE_SLOTS"),
  "open_presenter_modal_for_slot_at bounds checks slot_index ([0..MAX_SCHEDULE_SLOTS-1])"
);

const showModalBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::show_presenter_in_modal\s*\(/);
const ensureModalBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::ensure_modal_avatar_\s*\(\s*\)/);
ok(
  showModalBody.includes("this->ensure_modal_avatar_();"),
  "show_presenter_in_modal hands the fetch to ensure_modal_avatar_ (one request path)"
);
ok(
  ensureModalBody.includes("cmd.slot_index = -3;"),
  "ensure_modal_avatar_ assigns slot_index = -3 for the modal fetch"
);
ok(
  ensureModalBody.indexOf("if (this->enqueue_command_(cmd)) {") >= 0 &&
    ensureModalBody.indexOf("if (this->enqueue_command_(cmd)) {") <
      ensureModalBody.indexOf("this->modal_avatar_requested_url_ = expected;"),
  "the requested URL is recorded only after the worker queue accepts the fetch"
);
ok(
  ensureModalBody.includes("this->modal_avatar_retry_ms_ = esphome::millis() + 3000;"),
  "a full queue backs off instead of pretending the avatar is coming"
);

// Check routing in handle_worker_result_
const handleResBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::handle_worker_result_\s*\(/);
ok(
  handleResBody.includes("if (res.slot_index == -3) {") &&
    handleResBody.includes("res.url != this->modal_avatar_requested_url_") &&
    handleResBody.includes("ui_apply_modal_avatar(static_cast<esphome::image::Image *>(res.target_img));"),
  "handle_worker_result_ applies a slot_index == -3 image only to ui_apply_modal_avatar and only for the URL still wanted"
);
ok(
  handleResBody.includes("this->shown_modal_avatar_url_ = res.url;"),
  "the modal URL is marked shown only after a successful decode landed"
);
ok(
  handleResBody.includes("this->modal_avatar_retry_ms_ = esphome::millis() + 3000;"),
  "a failed modal fetch schedules a retry instead of leaving the avatar blank forever"
);
ok(
  handleResBody.includes("else if (res.slot_index >= 0 && res.slot_index < MAX_SCHEDULE_SLOTS) {\n          ui_apply_row_avatar(res.slot_index, img);"),
  "handle_worker_result_ routes row avatars strictly for res.slot_index >= 0 && < MAX_SCHEDULE_SLOTS"
);
ok(
  handleResBody.includes("if (res.slot_index == -1) {\n          ui_apply_logo(img);") &&
  handleResBody.includes("else if (res.slot_index == -2) {\n          ui_apply_now_avatar(img);"),
  "handle_worker_result_ isolates slot_index -1 (logo) and -2 (now_avatar) from -3 (modal)"
);

// ============================================================================
// 3. Stale Worker Results & Modal State Lifecycle
// ============================================================================
ok(
  showModalBody.indexOf("presenter_modal_show(") >= 0 &&
    showModalBody.indexOf("presenter_modal_show(") < showModalBody.indexOf("this->ensure_modal_avatar_();"),
  "modal paints its placeholder on Core 1 before the fetch is enqueued"
);
ok(
  !showModalBody.includes("placeholder = this->now_avatar_image_;"),
  "the 88px byline thumbnail is never scaled up into the 280px modal well"
);
ok(
  loopBody.includes("if (this->presenter_modal_state_.open) {") &&
    loopBody.includes("this->ensure_modal_avatar_();"),
  "loop() retries the modal portrait only while the modal is open"
);

// The bio lives at show level as well as on the presenter entry; the parser
// fills the first presenter's gaps so the modal cannot read as "No bio provided"
// for a host who has one.
const parseStateBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::parse_state_\s*\(/);
ok(
  parseStateBody.includes("if (p == 0) {") &&
    parseStateBody.includes("pi.tagline = res->byline.tagline;"),
  "parse_state_ falls back to the byline tagline for the host presenter"
);
const parseScheduleBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::parse_schedule_\s*\(/);
ok(
  parseScheduleBody.includes("if (p == 0) {") &&
    parseScheduleBody.includes("pi.tagline = slot.tagline;"),
  "parse_schedule_ falls back to the slot tagline for the host presenter"
);

const closeModalBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::close_presenter_modal\s*\(\s*\)/);
ok(
  closeModalBody.includes("this->presenter_modal_state_.open = false;") &&
  closeModalBody.includes("presenter_modal_dismiss();"),
  "close_presenter_modal updates state open = false and dismisses UI modal"
);

const applyModalAvatarBody = extractFunctionBody(uiCpp, /void\s+ui_apply_modal_avatar\s*\(/);
ok(
  applyModalAvatarBody.includes("if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;"),
  "ui_apply_modal_avatar validates image buffer and positive dimensions before updating widget"
);
ok(
  applyModalAvatarBody.includes("::lv_image_set_src(obj, img->get_lv_image_dsc());") &&
  applyModalAvatarBody.includes("lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);"),
  "ui_apply_modal_avatar sets lv_image src and unhides avatar widget"
);

// ============================================================================
// 4. Decompression Failure Graceful Fallback
// ============================================================================
const handleWorkerCmdBody = extractFunctionBody(clientCpp, /void\s+SubwaveDisplay::handle_worker_command_\s*\(/);
ok(
  handleWorkerCmdBody.includes("res->target_img = ok ? img : nullptr;") &&
    handleWorkerCmdBody.includes("res->status_code = ok ? 200 : 500;") &&
    handleWorkerCmdBody.includes("res->url = cmd.url_or_path;"),
  "handle_worker_command_ reports PNG fetch failures with the URL so the UI can stop waiting on them"
);

// Fallback label in YAML
ok(
  displayYaml.includes("id: presenter_avatar_label") && displayYaml.includes("text: \"ON AIR\""),
  "presenter_avatar_well contains fallback label 'ON AIR' when avatar decode fails or image is missing"
);

// ============================================================================
// 5. Zero Blocking Delay on Core 1 Loop
// ============================================================================
// Scan all functions in ui.cpp and Core 1 client methods for forbidden blocking calls
const core1Sources = [
  { name: "ui.cpp", src: uiCpp },
  { name: "open_presenter_modal_for_now", src: openNowBody },
  { name: "open_presenter_modal_for_slot", src: openSlotBody },
  { name: "close_presenter_modal", src: closeModalBody },
  { name: "SubwaveDisplay::loop", src: loopBody },
];

for (const entry of core1Sources) {
  const hasDelay = /\bdelay\s*\(/.test(entry.src);
  const hasVTaskDelay = /\bvTaskDelay\s*\(/.test(entry.src);
  const hasSleep = /\b(sleep|usleep)\s*\(/.test(entry.src);
  const hasBlockingHttp = /->perform\(|->start\(|http_request/.test(entry.src);

  ok(!hasDelay, `${entry.name} contains zero delay() calls`);
  ok(!hasVTaskDelay, `${entry.name} contains zero vTaskDelay() calls`);
  ok(!hasSleep, `${entry.name} contains zero sleep/usleep calls`);
  ok(!hasBlockingHttp, `${entry.name} contains zero blocking HTTP calls`);
}

// Ensure vTaskDelay in display_client.cpp is restricted strictly to Core 0 worker
// methods. Structural check rather than a hardcoded line range, which drifted as
// soon as the worker functions moved.
const countOccurrences = (src: string, needle: string) => src.split(needle).length - 1;
const fetchImgBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::fetch_image_to_runtime_image_\s*\(/);
const fetchCoverBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::fetch_cover_to_runtime_image_\s*\(/);
ok(
  countOccurrences(fetchImgBody, "vTaskDelay(") === 1 &&
    countOccurrences(fetchCoverBody, "vTaskDelay(") === 1 &&
    countOccurrences(clientCpp, "vTaskDelay(") === 2,
  "vTaskDelay() appears only in the two Core 0 stream loops"
);

// ============================================================================
// 6. Cache lock and fade regressions (touch clicks lost during Core 1 blocks)
// ============================================================================
const themeYaml = fs.readFileSync(path.join(process.cwd(), "device", "firmware", "common", "theme.yaml"), "utf8");
const settingsBody = extractFunctionBody(uiCpp, /void\s+settings_refresh\s*\(\s*\)/);
ok(
  !/avatar_cache_count|avatar_cache_kb/.test(settingsBody),
  "settings_refresh() takes no cache lock on the touch path"
);
const cacheCountBody = extractFunctionBody(clientCpp, /size_t\s+SubwaveDisplay::avatar_cache_count\s*\(\s*\)\s*const/);
const cacheKbBody = extractFunctionBody(clientCpp, /size_t\s+SubwaveDisplay::avatar_cache_kb\s*\(\s*\)\s*const/);
ok(
  cacheCountBody.includes(".load()") && cacheKbBody.includes(".load()"),
  "cache stats getters are lock-free atomic loads"
);
const cacheHitBody = extractFunctionBody(clientCpp, /bool\s+SubwaveDisplay::fetch_png_cached_\s*\(/);
ok(
  /cached_data\.get\(\)/.test(cacheHitBody) && cacheHitBody.includes("xSemaphoreGive(this->cache_mutex_);"),
  "cache-hit decode uses a copied handle outside the mutex"
);
ok(
  !/lv_timer_handler\s*\(\s*\)\s*;/.test(themeYaml),
  "theme fades never call lv_timer_handler() from a script"
);
ok(
  !/\bdelay\s*\(\s*\d+\s*\)\s*;/.test(themeYaml),
  "theme fades contain no blocking delay() steps"
);
ok(
  /lv_anim_start\s*\(/.test(themeYaml) && /lv_anim_set_completed_cb\s*\(/.test(themeYaml),
  "theme and artwork fades run as lv_anim animations"
);

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
