// Static gate for the staged firmware install.
//
// THE BEHAVIOUR THIS EXISTS TO KEEP.
// The panel is scanned out of PSRAM, and every flash operation suspends the
// external-memory cache, so writing the OTA image straight from the download
// loop paints a band of garbage on the glass every eight kilobytes. The fix
// has two halves and both are load-bearing:
//
//   1. The whole image is downloaded into a PSRAM buffer first. The download
//      performs no flash operation at all.
//   2. Only then is the backlight faded off, and the buffer is copied through a
//      DRAM bounce chunk into the inactive slot. Every failure after that point
//      must bring the screen back, because a black wall display is
//      indistinguishable from a broken one.
//
// The other invariant here is the one the product rests on: an install is an
// explicit tap. Nothing in discovery, a heartbeat, or a boot may start one.
//
// Run: npm run check:firmware-install

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

/** Numeric value of a constant, ignoring C separators such as 0x7C_0000. */
function numeric(m: RegExpExecArray | null): number {
  if (!m) return NaN;
  return Number(m[1].replace(/_/g, ""));
}

const REPO = process.cwd();
const FW = path.join(REPO, "device", "firmware");
const CLIENT_H = path.join(FW, "subwave_display", "display_client.h");
const CLIENT_CPP = path.join(FW, "subwave_display", "display_client.cpp");
const UI_H = path.join(FW, "subwave_display", "ui.h");
const UI_CPP = path.join(FW, "subwave_display", "ui.cpp");
const BUILD_YAML = path.join(FW, "builds", "subwave-jc8012p4a1.yaml");
const HARDWARE_YAML = path.join(FW, "common", "hardware.yaml");
const OTA_LIB = path.join(REPO, "lib", "firmware-ota.ts");
const OTA_ROUTE = path.join(REPO, "app", "api", "devices", "ota", "route.ts");

if (!fs.existsSync(CLIENT_CPP) || !fs.existsSync(UI_CPP)) {
  console.log("  note  firmware sources not present — check:firmware-install skipped.");
  process.exit(0);
}

const cpp = fs.readFileSync(CLIENT_CPP, "utf8");
const hdr = fs.readFileSync(CLIENT_H, "utf8");
const uiCpp = fs.readFileSync(UI_CPP, "utf8");
const uiH = fs.readFileSync(UI_H, "utf8");
const buildYaml = fs.readFileSync(BUILD_YAML, "utf8");
const hardwareYaml = fs.readFileSync(HARDWARE_YAML, "utf8");
const otaLib = fs.readFileSync(OTA_LIB, "utf8");
const otaRoute = fs.readFileSync(OTA_ROUTE, "utf8");

const body = extractFunctionBody(cpp, /bool\s+SubwaveDisplay::ota_install_\s*\(\s*\)/);
ok(body.length > 2000, "the ota_install_ body was found", `length=${body.length}`);

// ---------------------------------------------------------------------------
// 1. The contract matches the server, and the address is not negotiable.
// ---------------------------------------------------------------------------
{
  const fwPath = /constexpr\s+const\s+char\s*\*\s*OTA_DOWNLOAD_PATH\s*=\s*"([^"]+)"/.exec(cpp);
  ok(fwPath?.[1] === "/api/devices/ota", "the firmware's only download path is /api/devices/ota");
  ok(fs.existsSync(OTA_ROUTE), "and that path is the route the station serves");
  ok(!/\[[^\]]+\]/.test(OTA_ROUTE), "the route has no dynamic segment a screen could fill in");

  const fwMin = numeric(/constexpr\s+uint32_t\s+OTA_MIN_BYTES\s*=\s*([0-9a-fA-Fx_]+)/.exec(cpp));
  const fwMax = numeric(/constexpr\s+uint32_t\s+OTA_MAX_BYTES\s*=\s*([0-9a-fA-Fx_]+)/.exec(cpp));
  const srvMin = numeric(/export const MIN_OTA_BYTES = ([0-9a-fA-Fx_]+)/.exec(otaLib));
  const srvSlot = numeric(/export const APP_SLOT_BYTES = ([0-9a-fA-Fx_]+)/.exec(otaLib));
  ok(fwMin === srvMin && fwMin === 320, "the firmware's minimum image size is the server's", `${fwMin}/${srvMin}`);
  ok(fwMax === srvSlot, "and its maximum is one app slot", `${fwMax.toString(16)}/${srvSlot.toString(16)}`);

  ok(
    /ota_attempt_\.download_url\s*!=\s*OTA_DOWNLOAD_PATH/.test(body),
    "a response naming any other address is refused, not followed",
  );
  ok(
    body.includes("client->start(join(this->api_base_, OTA_DOWNLOAD_PATH), \"GET\", \"\", headers)"),
    "the request is built from the fixed path, not from the response",
  );
  ok(
    /headers\.push_back\(\{"Authorization", "Bearer " \+ this->bearer_\}\)/.test(body),
    "the token travels in the Authorization header",
  );
  ok(
    !/client->start\([^)]*bearer_/.test(body) && !/OTA_DOWNLOAD_PATH\s*\+\s*"/.test(body),
    "never in the URL and never with a query appended",
  );

  ok(
    /status\s*==\s*401[\s\S]{0,200}"unauthorized"/.test(body) &&
      /status\s*==\s*409[\s\S]{0,200}"no_live_attempt"/.test(body) &&
      /status\s*==\s*410[\s\S]{0,200}"artifact_missing"/.test(body),
    "the three defined refusals map to their own reasons",
  );
  ok(/status\s*!=\s*200/.test(body) && /"download_refused"/.test(body), "and any other status is a bounded refusal");

  ok(!/nextUrl\.searchParams/.test(otaRoute), "the stream takes no release selector");
  ok(/Content-Length": String\(result\.bytes\.length\)/.test(otaRoute), "and answers with an exact byte count");
}

// ---------------------------------------------------------------------------
// 2. The download performs no flash operation.
// ---------------------------------------------------------------------------
{
  const loopStart = body.indexOf("while (true)");
  const loopEnd = body.indexOf("container->end();", loopStart);
  const download = loopStart >= 0 && loopEnd > loopStart ? body.slice(loopStart, loopEnd) : "";
  ok(download.length > 500, "the download loop was found");

  ok(
    /heap_caps_malloc\(expected, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT\)/.test(body),
    "the whole image is staged in PSRAM",
  );
  ok(/const bool stage_in_ram = staged != nullptr;/.test(body), "and the staging decision is explicit");

  ok(
    /if\s*\(stage_in_ram\)\s*\{\s*memcpy\(staged\.get\(\) \+ previous, chunk, static_cast<size_t>\(n\)\);\s*\}\s*else if\s*\(esp_ota_write\(/.test(
      download,
    ),
    "staged bytes go to RAM; esp_ota_write is only the fallback arm",
  );
  ok(!download.includes("esp_ota_begin"), "the slot is not opened during a staged download");
  ok(!download.includes("esp_ota_abort"), "and nothing is aborted there either");
  ok(!download.includes("ui_ota_screen_on"), "the screen stays lit for the download");
  ok(download.includes("feed_wdt") && download.includes("yield"), "the loop feeds the watchdog and yields");

  ok(
    /if\s*\(received > static_cast<size_t>\(expected\)\)[\s\S]{0,120}break;/.test(download),
    "a download longer than the published image is stopped",
  );
  ok(
    /received != static_cast<size_t>\(expected\)/.test(body) && /"short_read"/.test(body),
    "a download shorter than the published image is refused",
  );

  // The fallback is the old streaming path, kept for an allocation failure. It
  // must still abort the half-written slot on every way out.
  const fallbackAborts = (body.match(/if \(!stage_in_ram\) esp_ota_abort\(handle\)/g) ?? []).length;
  ok(fallbackAborts >= 3, "the streaming fallback aborts the slot on stop, short read and checksum", `${fallbackAborts}`);
  ok(
    /!stage_in_ram && esp_ota_begin\(slot, expected, &handle\) != ESP_OK/.test(body),
    "and only the fallback opens the slot before the checksum",
  );
}

// ---------------------------------------------------------------------------
// 3. Flash writes happen behind a dark screen, not before the checksum.
// ---------------------------------------------------------------------------
{
  const firstBegin = body.indexOf("esp_ota_begin(");
  const secondBegin = body.lastIndexOf("esp_ota_begin(");
  const dark = body.indexOf("ui_ota_screen_on(false)");
  const verify = body.indexOf("ota_hex_matches");
  const setBoot = body.indexOf("esp_ota_set_boot_partition");
  const restart = body.indexOf("esp_restart");

  ok(verify > 0 && dark > verify, "the checksum is proved before the screen is taken");
  ok(dark > 0 && secondBegin > dark, "the staged slot is opened only after the screen is dark");
  ok(
    body.indexOf("esp_ota_write(handle, buffer, n)") > dark,
    "the staged flash write happens behind the dark screen, after the checksum",
  );

  ok(
    /esphome::delay\(1500\);\s*ui_ota_screen_on\(false\);/.test(body),
    "the install message is given 1.5 s to be read before the screen goes dark",
  );
  ok(
    /for \(int waited = 0; waited < 40 && !ui_ota_screen_is_off\(\); waited\+\+\) \{\s*esphome::delay\(50\);/.test(body),
    "then the worker waits up to 2 s for loopTask to apply it",
  );
  ok(
    /if \(!ui_ota_screen_is_off\(\)\) \{[\s\S]{0,600}?esphome::delay\(400\);/.test(body),
    "and waits out the 300 ms fade before the first write",
  );
  ok(
    /The screen did not go dark; this install will be visible\./.test(body),
    "a screen that would not darken is reported rather than silently flashing",
  );

  const rebootJournal = body.indexOf("j.phase = OTA_J_REBOOTING;");
  ok(setBoot > secondBegin && restart > setBoot, "the boot slot is switched, then the screen restarts");
  ok(
    rebootJournal > setBoot && !body.slice(rebootJournal, restart).includes("ui_ota_screen_on(true)"),
    "nothing relights the screen between the switch and the restart",
  );
  ok(
    /j\.phase = OTA_J_REBOOTING;[\s\S]{0,200}ota_journal_save_\(\);[\s\S]{0,1200}esp_restart\(\);/.test(body),
    "the reboot journal entry is saved before the restart",
  );
  {
    const stagedTail = body.slice(secondBegin, setBoot);
    const abortAt = stagedTail.indexOf("esp_ota_abort(handle)");
    ok(
      abortAt > 0 &&
        stagedTail.slice(Math.max(0, abortAt - 200), abortAt).includes("if (!written)") &&
        stagedTail.indexOf("esp_ota_abort", abortAt + 1) === -1,
      "the staged slot is aborted only when a piece failed to write",
    );
  }

  // Every refusal after the dark request must restore the screen first.
  const missing: string[] = [];
  let at = dark;
  while ((at = body.indexOf("ota_fail_(", at + 1)) !== -1) {
    const window = body.slice(Math.max(dark, at - 600), at);
    if (!window.includes("ui_ota_screen_on(true)")) {
      missing.push(body.slice(at, at + 60).replace(/\s+/g, " "));
    }
  }
  ok(missing.length === 0, "every failure after the screen goes dark brings it back first", missing.join(" | "));

  const restores = (body.match(/ui_ota_screen_on\(true\)/g) ?? []).length;
  ok(restores >= 4, "begin, write, image and boot-slot failures each restore the light", `${restores}`);
}

// ---------------------------------------------------------------------------
// 4. The staged write itself: one cache window per piece, DRAM source.
// ---------------------------------------------------------------------------
{
  const writeLoop = body.indexOf("while (offset < static_cast<size_t>(expected))");
  const segment = writeLoop >= 0 ? body.slice(writeLoop, body.indexOf("staged.reset()", writeLoop)) : "";
  ok(segment.length > 200, "the staged write loop was found");

  ok(/constexpr size_t kPiece = 8192;/.test(body), "the write piece is the flash driver's own 8 KB chunk");
  ok(
    /heap_caps_malloc\(kPiece, MALLOC_CAP_INTERNAL \| MALLOC_CAP_8BIT\)/.test(body),
    "the bounce buffer is in DRAM, readable while the cache is suspended",
  );
  ok(/memcpy\(buffer, staged\.get\(\) \+ offset, n\);/.test(segment), "each piece is copied out of PSRAM into DRAM");
  ok(/esp_ota_write\(handle, buffer, n\)/.test(segment), "and written from the DRAM buffer");
  ok(/feed_wdt/.test(segment) && /yield/.test(segment), "with a watchdog feed and a yield per piece");
  ok(
    /if \(bounce != nullptr\) heap_caps_free\(bounce\);/.test(body) &&
      /if \(!written\) \{\s*esp_ota_abort\(handle\);\s*ui_ota_screen_on\(true\);/.test(body),
    "a failed piece aborts the slot and restores the light",
  );
}

// ---------------------------------------------------------------------------
// 5. The tap is the only way in.
// ---------------------------------------------------------------------------
{
  const tap = extractFunctionBody(cpp, /void\s+SubwaveDisplay::request_firmware_update\s*\(\s*\)/);
  ok(tap.includes("WorkerCmdType::OTA_INSTALL") && tap.includes("this->enqueue_command_(cmd)"), "a tap only enqueues an install command");
  ok(!tap.includes("ota_install_("), "and never installs on the UI thread");

  const dispatch = /case WorkerCmdType::OTA_INSTALL:[\s\S]{0,80}this->ota_handle_tap_\(\);/.test(cpp);
  ok(dispatch, "the worker owns the install");

  const callSites = (cpp.match(/this->ota_install_\(\);/g) ?? []).length;
  ok(callSites === 2, "ota_install_ has exactly two call sites", `${callSites}`);
  const resume = extractFunctionBody(cpp, /void\s+SubwaveDisplay::ota_resume_\s*\(\s*\)/);
  const beginRequest = extractFunctionBody(cpp, /void\s+SubwaveDisplay::ota_begin_request_\s*\(\s*\)/);
  ok(
    resume.includes("this->ota_install_();") && beginRequest.includes("this->ota_install_();"),
    "both are the worker's resume and confirmed-request paths",
  );
  ok(
    !/ota_install_\(\)/.test(extractFunctionBody(cpp, /void\s+SubwaveDisplay::setup\s*\(\s*\)/)) &&
      !/ota_install_\(\)/.test(extractFunctionBody(cpp, /void\s+SubwaveDisplay::loop\s*\(\s*\)/)),
    "setup and loop never install",
  );
  ok(!/ota_install_/.test(buildYaml), "no YAML interval installs");

  const confirm = extractFunctionBody(uiCpp, /void\s+ui_confirm_firmware_update\s*\(\s*\)/);
  ok(
    /view\.state != OtaUiState::Available && view\.state != OtaUiState::Failed/.test(confirm),
    "only an open question may be answered",
  );
  ok(confirm.includes("c->request_firmware_update();"), "and answering it is what asks the worker");

  ok(/ota_install_running_/.test(hdr), "one install at a time is held by a running flag");
  ok(/if \(this->ota_install_running_\) return false;/.test(body), "and a second install is refused");
  ok(/if \(this->ota_install_running_\) return;/.test(cpp), "a second tap while one is running is dropped, not queued");
}

// ---------------------------------------------------------------------------
// 6. The UI can actually go dark, and does not fight the install.
// ---------------------------------------------------------------------------
{
  ok(/void\s+ui_ota_screen_on\(bool on\)/.test(uiH) && /bool\s+ui_ota_screen_is_off\(\)/.test(uiH),
    "the dark-screen handshake is declared");
  ok(
    /void ui_ota_screen_on\(bool on\) \{ s_ota_screen_wanted_off = !on; \}/.test(uiCpp),
    "asking for the screen is a request, applied by loopTask",
  );
  ok(/bool ui_ota_screen_is_off\(\) \{ return s_ota_screen_applied_off; \}/.test(uiCpp),
    "the worker observes the applied state, not the request",
  );

  const apply = extractFunctionBody(uiCpp, /static void ui_apply_ota_screen_\s*\(\s*\)/);
  ok(apply.includes("call.set_state(false);"), "applying an off request turns the light off");
  ok(
    /call\.set_state\(true\);\s*call\.set_brightness\(c == nullptr \? 1\.0f : \(float\) c->settings\(\)\.brightness \/ 100\.0f\);/.test(
      apply,
    ),
    "and coming back restores the operator's brightness, not a default",
  );
  ok(apply.includes("call.set_transition_length(300);"), "the transition is short enough to finish before the first write");

  const tick = extractFunctionBody(uiCpp, /void\s+ui_tick_firmware_dialog\s*\(\s*\)/);
  const applyAt = tick.indexOf("ui_apply_ota_screen_();");
  const early = tick.indexOf("if (s_ota_screen_applied_off) return;");
  ok(applyAt >= 0 && early > applyAt, "the tick applies the dark request before any early return");
  ok(
    early >= 0 && tick.indexOf("ui_paint_firmware_modal_();") > early,
    "and the painter is only reached while the screen is on",
  );

  const paint = extractFunctionBody(uiCpp, /static void ui_paint_firmware_modal_\s*\(\s*\)/);
  ok(
    paint.indexOf("if (s_ota_screen_applied_off) return;") >= 0 &&
      paint.indexOf("if (s_ota_screen_applied_off) return;") < paint.indexOf("auto *c = client();"),
    "the painter refuses to do LVGL work behind the darkness",
  );

  // The idle controller replaced the forced-on keepalive, so it is now one of
  // the two things that can fight the install for the backlight. Both of its
  // entries into the light — the one-second poll and a touch — must defer to
  // the install before they touch g_backlight at all.
  const idlePoll = extractFunctionBody(uiCpp, /void\s+idle_poll\s*\(\s*\)/);
  const pollGuard = idlePoll.indexOf("if (s_ota_screen_wanted_off || s_ota_screen_applied_off) return;");
  ok(
    pollGuard >= 0 && pollGuard < idlePoll.indexOf("g_backlight"),
    "the one-second idle tick cannot relight a screen the install holds dark",
  );
  const idleTouch = extractFunctionBody(uiCpp, /void\s+idle_touch\s*\(\s*\)/);
  const touchGuard = idleTouch.indexOf("if (s_ota_screen_wanted_off || s_ota_screen_applied_off) return;");
  ok(
    touchGuard >= 0 && touchGuard < idleTouch.indexOf("s_idle_touch_held = true;"),
    "and neither can a touch: while flash is written the install owns the screen, not the finger",
  );
  ok(
    apply.includes("if (!s_ota_screen_applied_off) idle_reclaim_screen_();"),
    "a failed or aborted install hands the screen back to the idle controller",
  );
  ok(
    /light:[\s\S]{0,200}restore_mode: ALWAYS_ON/.test(hardwareYaml),
    "the backlight's ALWAYS_ON restore brings the screen back with the new firmware",
  );
}

// ---------------------------------------------------------------------------
// 7. The boot contract around the install.
// ---------------------------------------------------------------------------
{
  const oneSecond = buildYaml.slice(buildYaml.indexOf("- interval: 1s"), buildYaml.indexOf("- interval: 45s"));
  ok(
    oneSecond.includes("script.execute: idle_tick") &&
      oneSecond.indexOf("subwave_display::ui_tick_firmware_dialog();") < oneSecond.indexOf("script.execute: idle_tick"),
    "the 1 s idle tick runs after the dialog tick, so an install request wins the same second",
  );
  ok(!/idle_apply/.test(buildYaml), "there is no forced-on backlight keepalive left to fight the install");
  ok(/startup_delay: 2s/.test(oneSecond), "the 1 s tick waits for the binding table");

  const heartbeatBlock = buildYaml.slice(buildYaml.indexOf("- interval: 45s"), buildYaml.indexOf("- interval: 5s"));
  ok(heartbeatBlock.includes("id(display_client)->send_heartbeat();"), "the 45 s heartbeat is how an offer reaches the screen");

  const version = /firmware_version:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(buildYaml);
  ok(version?.[1] !== undefined, "the build declares a semantic firmware_version");
  ok(buildYaml.includes('version: "${firmware_version}"'), "and the app descriptor uses that same value");

  ok(/cJSON_AddBoolToObject\(ota, "capable", true\)/.test(cpp), "the heartbeat advertises OTA capability");
  ok(
    /cJSON \*installed = cJSON_AddObjectToObject\(ota, "installed"\)/.test(cpp) &&
      /"sha256", this->ota_run_sha_/.test(cpp) &&
      /"slot", this->ota_run_slot_/.test(cpp),
    "and carries the running version, digest and slot as facts",
  );
  ok(
    /"phase", "rolled_back"/.test(cpp) && /"bootResult", "rolled_back"/.test(cpp) && /"boot_rollback"/.test(cpp),
    "a bootloader rollback is reported as rolled back, not as success",
  );
}

// ---------------------------------------------------------------------------
// 8. No new surface below the OTA API: no eFuse, no raw partition writes.
// ---------------------------------------------------------------------------
{
  ok(!/esp_efuse_/.test(cpp), "the firmware does not touch eFuses");
  ok(!/esp_partition_(write|erase)/.test(cpp), "nor raw partition writes (reads of the running slot are allowed)");
  ok(!/esp_flash_(write|erase|unprotect)/.test(cpp), "nor raw flash I/O");
  ok(!/secure_boot|flash_encryption/.test(buildYaml + hardwareYaml), "no secure-boot or encryption-mode change");

  const yamlFiles: string[] = [];
  for (const dir of ["common", "builds"]) {
    const full = path.join(FW, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith(".yaml") || name.endsWith(".yml")) yamlFiles.push(path.join(full, name));
    }
  }
  const customTables = yamlFiles.filter((file) => /^\s*partition_table:/m.test(fs.readFileSync(file, "utf8")));
  ok(customTables.length === 0, "no custom partition table is introduced", customTables.join(", "));
  ok(
    yamlFiles.length === 0 || !yamlFiles.some((file) => /bootloader:\s*\{?\s*$/.test(fs.readFileSync(file, "utf8"))),
    "the bootloader is not reconfigured",
  );
}

console.log(`  ${passed}/${passed + failed} staged-install assertions passed`);
if (failed > 0) process.exit(1);
