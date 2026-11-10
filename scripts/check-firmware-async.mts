// Static verification of the FreeRTOS background worker task and async queues.
//
// THE BUG THIS EXISTS TO CATCH.
// Running HTTP network requests, JSON parsing, or image operations directly on
// ESPHome's main loop thread (`loopTask`) causes multi-hundred-millisecond stalls
// (up to 2,850ms). During stalls, the GSL3680 touch controller (100Hz) drops touch
// events and LVGL UI frames drop from 60fps to 0fps.
//
// To prevent UI thread starvation, all network operations (state poll, schedule poll,
// heartbeat, settings push, skip, claim, bind) MUST run asynchronously on Core 0
// in `subwave_worker`; command producers must never block the UI thread.
//
// Run: npm run check:firmware-async

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

if (!fs.existsSync(CLIENT_H) || !fs.existsSync(CLIENT_CPP)) {
  console.log("  note  firmware sources not present — check:firmware-async skipped.");
  process.exit(0);
}

const hSrc = fs.readFileSync(CLIENT_H, "utf8");
const cppSrc = fs.readFileSync(CLIENT_CPP, "utf8");

// 1. Task Creation & FreeRTOS Pinning
ok(
  /xTaskCreatePinnedToCore\s*\(\s*SubwaveDisplay::worker_task_entry_,\s*"subwave_worker",\s*16384,[\s\S]*?this,[\s\S]*?2,[\s\S]*?&this->worker_task_handle_,[\s\S]*?0[\s\S]*?\)/.test(
    cppSrc,
  ),
  "subwave_worker task created on Core 0 with 16KB stack and priority 2",
);

// 2. Command & Result Queue Definitions & Allocation
ok(
  /QueueHandle_t\s+worker_cmd_queue_/.test(hSrc) && /QueueHandle_t\s+ui_result_queue_/.test(hSrc),
  "FreeRTOS command and result queue handles declared in display_client.h",
);

ok(
  /xQueueCreate\s*\(\s*16,\s*sizeof\s*\(\s*WorkerCommand\s*\)\s*\)/.test(cppSrc) &&
    /xQueueCreate\s*\(\s*16,\s*sizeof\s*\(\s*WorkerResult\s*\*\s*\)\s*\)/.test(cppSrc),
  "FreeRTOS queues allocated in setup() with depth 16",
);

// 3. Non-blocking Queue Enqueue (0 ticks timeout)
ok(
  /bool\s+SubwaveDisplay::enqueue_command_\s*\([^)]*\)\s*\{[\s\S]*?xQueueSend\s*\(\s*this->worker_cmd_queue_,\s*&cmd,\s*0\s*\)/.test(
    cppSrc,
  ),
  "enqueue_command_ uses 0-tick timeout to guarantee loopTask never blocks",
);

const enqueueResultFn = extractFunctionBody(cppSrc, /bool\s+SubwaveDisplay::enqueue_result_\s*\(/);
ok(
  /TickType_t\s+wait_ticks\s*=\s*res->type\s*==\s*WorkerResultType::COVER_ART_READY\s*\?\s*portMAX_DELAY\s*:\s*0\s*;/.test(enqueueResultFn) &&
    /xQueueSend\s*\(\s*this->ui_result_queue_,\s*&res,\s*wait_ticks\s*\)/.test(enqueueResultFn),
  "worker retains cover completions until the UI can receive them; other results remain non-blocking",
);

// 4. UI Loop Drains Result Queue Safely on loopTask
ok(
  /void\s+SubwaveDisplay::loop\s*\(\s*\)\s*\{[\s\S]*?xQueueReceive\s*\(\s*this->ui_result_queue_,\s*&res,\s*0\s*\)[\s\S]*?handle_worker_result_/.test(
    cppSrc,
  ),
  "SubwaveDisplay::loop() drains ui_result_queue_ non-blockingly and dispatches results on loopTask",
);

// 5. Worker Command Types and Result Types
const expectedCmds = [
  "POLL_STATE",
  "POLL_SCHEDULE",
  "SEND_HEARTBEAT",
  "PUSH_SETTINGS",
  "SKIP_TRACK",
  "CLAIM_DEVICE",
  "BIND_STATION",
  "FETCH_PNG",
  "FETCH_COVER_ART",
  "CHECK_CONNECTIVITY",
];
for (const cmd of expectedCmds) {
  ok(
    new RegExp(`\\b${cmd}\\b`).test(hSrc) &&
      new RegExp(`case\\s+WorkerCmdType::${cmd}:`).test(cppSrc),
    `WorkerCmdType::${cmd} defined and handled in worker_loop_`,
  );
}

const expectedResults = [
  "STATE_UPDATED",
  "SCHEDULE_UPDATED",
  "HEARTBEAT_DONE",
  "SETTINGS_SYNCED",
  "SKIP_DONE",
  "CLAIM_DONE",
  "BIND_DONE",
  "IMAGE_DECODED",
  "COVER_ART_READY",
  "CONNECTIVITY_RESULT",
];
for (const res of expectedResults) {
  ok(
    new RegExp(`\\b${res}\\b`).test(hSrc) &&
      new RegExp(`case\\s+WorkerResultType::${res}:`).test(cppSrc),
    `WorkerResultType::${res} defined and dispatched in handle_worker_result_`,
  );
}

// 6. Decoupled update() — enqueues commands instead of making blocking HTTP requests inline
const updateFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::update\s*\(\s*\)/);
ok(
  updateFn.length > 0 &&
    !/->start\(|->perform\(|http_request/.test(updateFn) &&
    /poll_state_|\bWorkerCmdType::BIND_STATION\b/.test(updateFn),
  "SubwaveDisplay::update() enqueues async commands and contains zero inline HTTP calls",
);

// 7. Decoupled request_skip() — optimistic UI feedback and async enqueue
const skipFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::request_skip\s*\(\s*\)/);
ok(
  skipFn.length > 0 &&
    !/->start\(|->perform\(|http_request/.test(skipFn) &&
    /now_refresh\(\)/.test(skipFn) &&
    /WorkerCmdType::SKIP_TRACK/.test(skipFn),
  "request_skip() provides optimistic UI update and enqueues SKIP_TRACK to worker",
);

// 8. Decoupled push_settings() with 500ms debounce
const pushSettingsFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::push_settings\s*\(/);
ok(
  pushSettingsFn.length > 0 &&
    !/->start\(|->perform\(|http_request/.test(pushSettingsFn) &&
    /settings_pending_push_\s*=\s*true/.test(pushSettingsFn),
  "push_settings() stores settings with debounce flag and does not block inline",
);

ok(
  /settings_pending_push_[\s\S]*?now\s*-\s*this->settings_push_ms_\s*>=\s*500[\s\S]*?WorkerCmdType::PUSH_SETTINGS/.test(
    cppSrc,
  ),
  "500ms debounce timer drains pending settings push via WorkerCmdType::PUSH_SETTINGS",
);

// 9. Decoupled send_heartbeat() — enqueues SEND_HEARTBEAT
const heartbeatFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::send_heartbeat_\s*\(\s*\)/);
ok(
  heartbeatFn.length > 0 &&
    !/->start\(|->perform\(|http_request/.test(heartbeatFn) &&
    /WorkerCmdType::SEND_HEARTBEAT/.test(heartbeatFn),
  "send_heartbeat_() snapshots network metrics and enqueues SEND_HEARTBEAT",
);

// 10. Decoupled bind() — enqueues BIND_STATION
const bindFn = extractFunctionBody(cppSrc, /bool\s+SubwaveDisplay::bind\s*\(/);
ok(
  bindFn.length > 0 &&
    !/->start\(|->perform\(|http_request/.test(bindFn) &&
    /WorkerCmdType::BIND_STATION/.test(bindFn),
  "bind() enqueues BIND_STATION to background worker",
);

// 11. Phase 3: Background Image Decoding on Core 0
const fetchImgFn = extractFunctionBody(cppSrc, /bool\s+SubwaveDisplay::fetch_image_to_runtime_image_\s*\(/);
ok(
  fetchImgFn.length > 0 &&
    /img->begin_decode/.test(fetchImgFn) &&
    /img->feed_data/.test(fetchImgFn) &&
    /img->end_decode/.test(fetchImgFn),
  "fetch_image_to_runtime_image_ streams and decodes images chunk-by-chunk on background worker",
);

const fetchCoverFn = extractFunctionBody(cppSrc, /bool\s+SubwaveDisplay::fetch_cover_to_runtime_image_\s*\(/);
ok(
  fetchCoverFn.length > 0 &&
    /img->begin_decode/.test(fetchCoverFn) &&
    /img->feed_data/.test(fetchCoverFn) &&
    /img->end_decode/.test(fetchCoverFn) &&
    /vTaskDelay\(1\)/.test(fetchCoverFn),
  "fetch_cover_to_runtime_image_ streams and decodes JPEG cover art on Core 0 background worker",
);

const loopFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::loop\s*\(\s*\)/);
ok(
  loopFn.length > 0 &&
    !/target->update\(\)/.test(loopFn) &&
    /WorkerCmdType::FETCH_COVER_ART/.test(loopFn),
  "SubwaveDisplay::loop() enqueues FETCH_COVER_ART and contains zero synchronous target->update() calls",
);

// 12. Phase 3: UI apply helpers exist in ui.cpp and are dispatched safely
const uiCpp = fs.readFileSync(path.join(FW, "ui.cpp"), "utf8");
ok(
  /void\s+ui_apply_logo\s*\(/.test(uiCpp) &&
    /void\s+ui_apply_now_avatar\s*\(/.test(uiCpp) &&
    /void\s+ui_apply_row_avatar\s*\(/.test(uiCpp) &&
    /void\s+ui_apply_cover_art\s*\(/.test(uiCpp),
  "UI image application functions defined in ui.cpp",
);

// 13. Phase 3: Zero synchronous image decoding in YAML interval: 1s
const yamlPath = path.join(process.cwd(), "device", "firmware", "builds", "subwave-jc8012p4a1.yaml");
const yamlSrc = fs.readFileSync(yamlPath, "utf8");
const intervalMatch = /interval:\s*1s[\s\S]*?(?=startup_delay:|$)/.exec(yamlSrc);
const intervalBlock = intervalMatch ? intervalMatch[0] : "";
ok(
  intervalBlock.length > 0 &&
    !/fetch_png|pending_logo_url|pending_art_url|pending_now_avatar_url|pending_row_avatar_url|->update\(\)/.test(intervalBlock),
  "YAML interval: 1s contains ZERO synchronous image fetch or decode operations",
);

// 14. Phase 3: Runtime image and art controls bound
const bindingYaml = fs.readFileSync(path.join(process.cwd(), "device", "firmware", "common", "binding.yaml"), "utf8");
ok(
  /bind_runtime_images/.test(bindingYaml) &&
    /bind_art_controls/.test(bindingYaml) &&
    /set_connectivity_reported_script/.test(bindingYaml),
  "Runtime images, art controls, and connectivity script bound in binding.yaml",
);

// 15. Phase 4: Decoupled Network Diagnostics (request_connectivity_check)
const reqConnFn = extractFunctionBody(cppSrc, /void\s+SubwaveDisplay::request_connectivity_check\s*\(\s*\)/);
ok(
  reqConnFn.length > 0 &&
    !/route_exists|resolve_host|connects_to/.test(reqConnFn) &&
    /WorkerCmdType::CHECK_CONNECTIVITY/.test(reqConnFn),
  "request_connectivity_check() is non-blocking on loopTask and enqueues CHECK_CONNECTIVITY",
);

const ladderFn = extractFunctionBody(cppSrc, /Connectivity\s+SubwaveDisplay::run_connectivity_ladder_\s*\(\s*\)/);
ok(
  ladderFn.length > 0 &&
    /route_exists\(\)/.test(ladderFn) &&
    /resolve_host\(/.test(ladderFn) &&
    /connects_to\(/.test(ladderFn),
  "run_connectivity_ladder_ executes the 4-step diagnostic ladder off the UI thread",
);

// 16. Phase 4: UI scripts use non-blocking connectivity check and reported callback
const scriptsYaml = fs.readFileSync(path.join(process.cwd(), "device", "firmware", "common", "screens", "scripts.yaml"), "utf8");
ok(
  /id:\s*connectivity_reported/.test(scriptsYaml) &&
    /request_connectivity_check/.test(scriptsYaml) &&
    !/auto\s+result\s*=\s*c->check_connectivity\(\)/.test(scriptsYaml),
  "UI setup scripts trigger async request_connectivity_check and handle results via connectivity_reported",
);

const enqueueCoverFn = extractFunctionBody(loopFn, /if\s*\(\s*this->enqueue_command_\(cmd\)\s*\)/);
ok(
  enqueueCoverFn.includes("this->pending_art_url_.clear();") &&
    enqueueCoverFn.includes("this->cover_in_flight_ = true;") &&
    (loopFn.match(/pending_art_url_\.clear\(\)/g) || []).length === 1 &&
    (loopFn.match(/cover_in_flight_\s*=\s*true/g) || []).length === 1,
  "cover URL and in-flight state change only when the fetch command is accepted",
);

const applyCoverFn = extractFunctionBody(uiCpp, /void\s+ui_apply_cover_art\s*\(/);
const uiHeader = fs.readFileSync(path.join(FW, "ui.h"), "utf8");
ok(
  /ui_apply_cover_art\(esphome::image::Image \*img, int slot\)/.test(uiHeader) &&
    /lv_obj_t\s*\*obj\s*=\s*slot\s*==\s*1\s*\?\s*OBJ\(art_out\)\s*:\s*OBJ\(art_in\)/.test(applyCoverFn),
  "cover publication selects the fixed widget associated with the completed decode slot",
);
ok(
  applyCoverFn.includes("img->get_data_start() == nullptr") &&
    applyCoverFn.includes("img->get_width() <= 0") &&
    applyCoverFn.includes("img->get_height() <= 0"),
  "invalid artwork cannot replace the displayed cover",
);
const coverResultFn = extractFunctionBody(cppSrc, /case\s+WorkerResultType::COVER_ART_READY\s*:/);
ok(
  coverResultFn.includes("ui_apply_cover_art(img, res.slot_index);") &&
    coverResultFn.includes("this->cover_in_flight_ = false;"),
  "cover completion forwards its decode slot and releases the in-flight latch",
);
const themeYaml = fs.readFileSync(path.join(FW, "..", "common", "theme.yaml"), "utf8");
ok(
  /bind_object\("art_in", id\(art_in\)\)/.test(bindingYaml) &&
    /bind_object\("art_out", id\(art_out\)\)/.test(bindingYaml) &&
    /lv_obj_t\* out = id\(art_out\);\s*lv_obj_t\* in\s*= id\(art_in\);\s*id\(art_out\) = in;\s*id\(art_in\)\s*= out;\s*id\(art_slot\) = !id\(art_slot\);/.test(themeYaml) &&
    /cmd.slot_index = \(this->art_slot_ && \*this->art_slot_\) \? 1 : 0;/.test(loopFn),
  "crossfade roles and decode slot alternate together while C++ widget bindings remain fixed",
);

const effectsDrawFn = extractFunctionBody(uiCpp, /void\s+art_effects_draw\s*\(/);
const effectsTickFn = extractFunctionBody(uiCpp, /void\s+art_effects_tick\s*\(/);
const readyFn = extractFunctionBody(uiCpp, /void\s+ui_mark_ready\s*\(/);
ok(
  readyFn.includes("lv_obj_add_event_cb(OBJ(art_layers), art_effects_draw, LV_EVENT_DRAW_POST, nullptr);") &&
    readyFn.includes("lv_timer_create(art_effects_tick, 33, OBJ(art_layers));"),
  "artwork overlays draw above both covers and update on a nonblocking LVGL timer",
);
ok(
  effectsTickFn.includes("!c->stream_idle()") && effectsTickFn.includes("lv_obj_is_visible(obj)") &&
    effectsTickFn.includes("{OBJ(art_in), OBJ(art_out)}") &&
    effectsTickFn.includes("!lv_obj_has_flag(cover, LV_OBJ_FLAG_HIDDEN)") &&
    effectsTickFn.includes("lv_image_get_src(cover) != nullptr") &&
    effectsTickFn.includes("lv_obj_get_style_opa(cover, LV_PART_MAIN) > LV_OPA_MIN") &&
    effectsTickFn.includes("if (active || was_active)"),
  "effects run only with visible artwork and clear the last frame when the stream becomes idle",
);
ok(
  effectsDrawFn.includes("i < 4") && effectsDrawFn.includes("i * 450") &&
    effectsDrawFn.includes("% 3200") && effectsDrawFn.includes("% 4500") &&
    effectsDrawFn.includes("lv_draw_arc(layer, &ring)") && effectsDrawFn.includes("INT(c_accent)"),
  "four accent-coloured sonar rings retain the web cadence and stagger alongside the light sweep",
);
ok(
  effectsDrawFn.includes("sweep.bg_grad.stops_count = 2;") &&
    (effectsDrawFn.match(/lv_draw_rect\(layer, &sweep, &band\)/g) || []).length === 2,
  "light sweep uses two gradient halves within the firmware's two-stop limit",
);
ok(
  effectsDrawFn.includes("std::max(saved_clip.x1, bounds.x1)") &&
    effectsDrawFn.includes("std::max(saved_clip.y1, bounds.y1)") &&
    effectsDrawFn.includes("std::min(saved_clip.x2, bounds.x2)") &&
    effectsDrawFn.includes("std::min(saved_clip.y2, bounds.y2)") &&
    effectsDrawFn.includes("layer->_clip_area = saved_clip;"),
  "oversized rings and moving sweep remain clipped to artwork without leaking the clip state",
);
ok(
  !/\b(?:delay|vTaskDelay|lv_timer_handler|lv_obj_invalidate|lv_obj_set_\w+)\s*\(/.test(effectsDrawFn) &&
    !/\b(?:delay|vTaskDelay|lv_timer_handler)\s*\(/.test(effectsTickFn),
  "effects never block or mutate widgets during drawing",
);

if (failed > 0) {
  console.error(`\n${failed} firmware-async assertion(s) failed.`);
  process.exit(1);
}

console.log(`  ${passed}/${passed} firmware-async assertions passed`);
