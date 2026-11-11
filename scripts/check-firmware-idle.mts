// The inactivity controller: dimming, screen-off and touch wake.
//
// WHY A NATIVE HARNESS AND NOT ONLY A STATIC GATE. The three behaviors this
// feature exists for are all statements about TIME: "dims after X", "goes off
// after another Y", "a held finger prevents both". A source-shape assertion can
// prove the call exists; it cannot prove that the thresholds, the ordering of
// the second delay and the wrap-safe subtraction actually produce those
// outcomes. So the policy lives in idle_policy.h with no ESPHome dependency,
// and this gate compiles and runs it with a real C++ compiler.
//
// The harness is then proved to have teeth by mutation: the same driver is
// compiled a second time against a copy of the header with "dim and never turn
// off" (the behavior that shipped before this change) substituted back in, and
// the run must FAIL. A test that passes against the old behavior is describing
// nothing.
//
// The rest of the gate covers what a pure function cannot: the phase the
// controller adopts on a touch, the shield that swallows the waking gesture, the
// boot ordering, the artwork suspension, the OTA precedence, the dialog's
// settings writes and the server/migration contract.
//
// Run: npm run check:firmware-idle
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

const REPO = process.cwd();
const FW = path.join(REPO, "device", "firmware");
const UI_CPP = path.join(FW, "subwave_display", "ui.cpp");
const UI_H = path.join(FW, "subwave_display", "ui.h");
const POLICY_H = path.join(FW, "subwave_display", "idle_policy.h");
const CLIENT_H = path.join(FW, "subwave_display", "display_client.h");
const CLIENT_CPP = path.join(FW, "subwave_display", "display_client.cpp");
const DISPLAY = path.join(FW, "common", "display.yaml");
const BINDING = path.join(FW, "common", "binding.yaml");
const SCRIPTS = path.join(FW, "common", "screens", "scripts.yaml");
const SETTINGS_SCREEN = path.join(FW, "common", "screens", "settings.yaml");
const BUILD = path.join(FW, "builds", "subwave-jc8012p4a1.yaml");
const SCHEMA = path.join(REPO, "prisma", "schema.prisma");
const MIGRATION = path.join(REPO, "prisma", "migrations", "20261110000000_add_idle_off_min", "migration.sql");
const SERVICE = path.join(REPO, "lib", "device-service.ts");
const TYPES = path.join(REPO, "lib", "device-types.ts");
const ADMIN_ROUTE = path.join(REPO, "app", "api", "admin", "devices", "route.ts");

const required = [UI_CPP, POLICY_H, DISPLAY, BINDING, SCRIPTS, BUILD, SCHEMA, MIGRATION];
if (required.some((p) => !fs.existsSync(p))) {
  console.log("  note  firmware or schema sources not present — the idle check did not run.");
  console.log(`  ${passed}/${passed + failed} idle assertions passed`);
  process.exit(0);
}

const read = (p: string) => fs.readFileSync(p, "utf8");
const ui = read(UI_CPP);
const display = read(DISPLAY);
const binding = read(BINDING);
const scripts = read(SCRIPTS);
const settingsScreen = read(SETTINGS_SCREEN);
const build = read(BUILD);
const schema = read(SCHEMA);
const migration = read(MIGRATION);
const service = read(SERVICE);
const types = read(TYPES);
const adminRoute = read(ADMIN_ROUTE);
const clientH = read(CLIENT_H);
const clientCpp = read(CLIENT_CPP);

/** The braces of one function definition, without its signature. */
function body(src: string, signature: RegExp): string {
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

const init = body(ui, /void\s+idle_init\s*\(\s*\)/);
const poll = body(ui, /void\s+idle_poll\s*\(\s*\)/);
const touch = body(ui, /void\s+idle_touch\s*\(\s*\)/);
const move = body(ui, /void\s+idle_touch_move\s*\(\s*\)/);
const release = body(ui, /void\s+idle_release\s*\(\s*\)/);
const manual = body(ui, /void\s+idle_set_manual_brightness\s*\(\s*int\s+percent\s*\)/);
const enter = body(ui, /static void idle_enter_\s*\(/);
const applyLight = body(ui, /static void apply_light_\s*\(/);
const reclaim = body(ui, /static void idle_reclaim_screen_\s*\(\s*\)\s*\{/);
const effects = body(ui, /bool\s+idle_effects_suspended\s*\(\s*\)/);
const refresh = body(ui, /void\s+ui_refresh_idle_dialog\s*\(\s*\)/);
const settingsRefresh = body(ui, /void\s+settings_refresh\s*\(\s*\)/);
const artTick = body(ui, /void\s+art_effects_tick\s*\(/);
const otaApply = body(ui, /static void ui_apply_ota_screen_\s*\(\s*\)/);
const parseState = body(clientCpp, /bool\s+SubwaveDisplay::parse_state_\s*\(/);

// The regions of ui.cpp that are not the controller.
const controllerAt = ui.indexOf("// The inactivity controller.");
const beforeController = controllerAt > 0 ? ui.slice(0, controllerAt) : "";

// ---------------------------------------------------------------------------
// 1. One policy, one clock, one owner of the backlight.
// ---------------------------------------------------------------------------
{
  ok(ui.includes('#include "idle_policy.h"'), "the firmware and this gate exercise one shared policy header");
  ok(init !== "" && poll !== "" && touch !== "" && move !== "" && release !== "", "the controller's entry points exist");
  ok(init.trimStart().startsWith("if (!ui_ready()) return;"), "the controller refuses to start before the bindings exist");
  ok(
    !/idle_deadline_ms/.test(ui + display + binding + scripts),
    "the YAML deadline global is gone — there is no second clock to disagree with the controller",
  );
  ok(
    !/\bidle_apply\b/.test(ui + display + binding + scripts + build),
    "the forced-on keepalive is gone — one policy-aware path replaced it",
  );
  ok(
    !/idle_cycle|idle_arm\b/.test(scripts + settingsScreen),
    "no mode-cycling tap and no wake-through-a-script path remain",
  );

  const dimMs = Number(/IDLE_DIM_TRANSITION_MS\s*=\s*(\d+)/.exec(ui)?.[1]);
  const wakeMs = Number(/IDLE_WAKE_TRANSITION_MS\s*=\s*(\d+)/.exec(ui)?.[1]);
  const offMs = Number(/IDLE_OFF_TRANSITION_MS\s*=\s*(\d+)/.exec(ui)?.[1]);
  ok(dimMs >= 500, "dimming fades slowly enough to read as the screen settling");
  ok(wakeMs > 0 && wakeMs <= 200, "a wake is answered in one short transition, not another fade");
  ok(offMs >= 300, "turning off is not an instant cut");

  ok(
    applyLight.includes("if (s_light_on == on && (!on || s_light_percent == percent)) return;"),
    "the light is only commanded when the target actually changes — a poll cannot restart a fade",
  );
  ok(
    build.includes("- interval: 1s") && /interval: 1s[\s\S]{0,2000}?script\.execute: idle_tick/.test(build),
    "one one-second tick is the controller's only clock",
  );
  ok(
    !/interval: 5s[\s\S]{0,400}?idle_tick/.test(build),
    "the idle tick does not also run at five seconds",
  );
}

// ---------------------------------------------------------------------------
// 2. Every touch is activity; a touch on a dark screen is wake-only.
// ---------------------------------------------------------------------------
{
  for (const [name, fn] of [
    ["touch down", touch],
    ["movement", move],
  ] as const) {
    ok(fn.includes("s_idle_touch_held = true;"), `${name}: the controller knows the finger is down`);
    ok(
      fn.includes("idle_enter_(subwave_idle::Phase::Awake, IDLE_WAKE_TRANSITION_MS)"),
      `${name}: wakes immediately when not awake`,
    );
    ok(
      fn.includes("if (s_idle_phase == subwave_idle::Phase::Off) s_idle_wake_gesture = true;"),
      `${name}: a touch that wakes a dark screen claims the whole gesture`,
    );
  }
  ok(touch.includes("s_idle_last_activity_ms = now;"), "touch down restarts the full period");
  ok(move.includes("s_idle_last_activity_ms = esphome::millis();"), "movement restarts it too");
  ok(release.includes("s_idle_touch_held = false;"), "release clears the hold");
  ok(release.includes("s_idle_last_activity_ms = esphome::millis();"), "and release itself counts as activity");
  ok(
    release.includes("if (s_idle_wake_gesture) {") &&
      release.includes("lv_obj_add_flag(shield, LV_OBJ_FLAG_HIDDEN)"),
    "the shield comes down on release, so the next gesture is a normal one",
  );
  ok(
    enter.includes("if (phase == subwave_idle::Phase::Off) {") &&
      enter.includes("} else if (!s_idle_wake_gesture) {"),
    "the shield is shown when off and kept through the wake-only gesture",
  );
  ok(
    enter.includes("lv_obj_move_foreground(shield)"),
    "going dark re-raises the shield above a dialog that was left open",
  );

  // The input triggers are the only callers: a heartbeat, a track change or a
  // settings repaint must not reach any of these.
  ok(
    !/idle_touch\s*\(|idle_enter_\s*\(|idle_poll\s*\(|idle_set_manual_brightness\s*\(/.test(beforeController),
    "nothing outside the controller calls a wake path — heartbeats and artwork cannot wake the screen",
  );
  ok(
    !/idle_touch|idle_enter_|s_idle_last_activity_ms|idle_set_manual_brightness/.test(settingsRefresh),
    "a settings repaint cannot wake the screen or restart the period",
  );
  ok(
    !/idle_touch|idle_enter_|idle_set_manual_brightness/.test(parseState),
    "a state poll or heartbeat response cannot wake the screen",
  );

  ok(/on_touch:[\s\S]{0,600}?subwave_display::idle_touch\(\);/.test(display), "the touchscreen's down trigger calls the controller");
  ok(/on_update:\s*\n\s*- lambda: subwave_display::idle_touch_move\(\);/.test(display), "movement is wired to the controller");
  ok(/on_release:[\s\S]{0,300}?subwave_display::idle_release\(\);/.test(display), "release is wired to the controller");

  // The shield: full screen, transparent, clickable, hidden by default, and last
  // in the page so it is above every window and both modals.
  const shieldIdx = display.indexOf("id: wake_shield");
  ok(shieldIdx > 0, "the wake shield is declared");
  const shield = shieldIdx > 0 ? display.slice(shieldIdx, shieldIdx + 700) : "";
  ok(shield.includes("width: 100%") && shield.includes("height: 100%"), "it covers the whole page");
  ok(shield.includes("bg_opa: TRANSP"), "it is transparent: the backlight is off, so nothing is drawn over the fade");
  ok(shield.includes("clickable: true"), "but it is clickable, so LVGL delivers the press to it");
  ok(shield.includes("hidden: true"), "and it starts hidden");
  ok(
    shieldIdx > display.indexOf("id: ota_modal") && shieldIdx > display.indexOf("id: idle_modal"),
    "it is declared above both modals",
  );
  const afterShield = shieldIdx > 0 ? display.slice(shieldIdx) : "";
  ok(
    !/\n {8}- (obj|label|button):/.test(afterShield),
    "it is the last widget on the page — nothing can be hit-tested above it",
  );
  ok(binding.includes('bind_object("wake_shield", id(wake_shield));'), "the shield is bound to the controller");
}

// ---------------------------------------------------------------------------
// 3. The policy: sequences, deadlines, hold and rollover, run natively.
// ---------------------------------------------------------------------------
const driver = String.raw`
#include "idle_policy.h"

#include <cstdint>
#include <cstdio>

using namespace subwave_idle;

static int g_checks = 0;
static int g_failures = 0;

static void check(bool cond, const char *what) {
  g_checks++;
  if (!cond) {
    g_failures++;
    std::printf("FAIL %s\n", what);
  }
}

static const uint32_t MIN = 60000u;

int main() {
  // Stay on: no timeout has any effect.
  {
    const Policy p = policy_for("stay", 15, 30);
    check(p.stay, "stay mode is recognised");
    check(next_phase(Phase::Awake, false, 0, 0, p) == Phase::Awake, "stay: awake at zero");
    check(next_phase(Phase::Awake, false, 15 * MIN - 1, 0, p) == Phase::Awake, "stay: awake one ms before the timeout");
    check(next_phase(Phase::Awake, false, 15 * MIN, 0, p) == Phase::Awake, "stay: awake at the timeout");
    check(next_phase(Phase::Awake, false, 500 * MIN, 0, p) == Phase::Awake, "stay: never leaves awake");
  }

  // Dim, never off.
  {
    const Policy p = policy_for("dim", 5, 0);
    check(!p.stay && !p.off_only, "dim mode is its own policy");
    check(next_phase(Phase::Awake, false, 5 * MIN - 1, 0, p) == Phase::Awake, "dim: awake one ms before the timeout");
    check(next_phase(Phase::Awake, false, 5 * MIN, 0, p) == Phase::Dimmed, "dim: dimmed at the timeout");
    check(next_phase(Phase::Dimmed, false, 5 * MIN + 1000, 1000, p) == Phase::Dimmed, "dim: stays dim");
    check(next_phase(Phase::Dimmed, false, 500 * MIN, 495 * MIN, p) == Phase::Dimmed, "dim: never turns itself off");
  }

  // Off, directly, after the one timeout.
  {
    const Policy p = policy_for("off", 7, 30);
    check(p.off_only, "off mode is recognised");
    check(next_phase(Phase::Awake, false, 7 * MIN - 1, 0, p) == Phase::Awake, "off: awake one ms before the timeout");
    check(next_phase(Phase::Awake, false, 7 * MIN, 0, p) == Phase::Off, "off: dark at the timeout, without a dim stop");
    check(next_phase(Phase::Off, false, 0, 0, p) == Phase::Off, "off: the policy never turns a dark screen back on");
  }

  // Dim, then off after the ADDITIONAL delay. The second delay counts from the
  // moment the screen dimmed, not from the last touch.
  {
    const Policy p = policy_for("dim", 10, 20);
    check(next_phase(Phase::Awake, false, 10 * MIN - 1, 0, p) == Phase::Awake, "dim+off: awake before the first timeout");
    check(next_phase(Phase::Awake, false, 10 * MIN, 0, p) == Phase::Dimmed, "dim+off: dimmed at the first timeout");
    check(
        next_phase(Phase::Dimmed, false, 10 * MIN + 20 * MIN - 1, 20 * MIN - 1, p) == Phase::Dimmed,
        "dim+off: still dim one ms before the additional delay");
    check(
        next_phase(Phase::Dimmed, false, 10 * MIN + 20 * MIN, 20 * MIN, p) == Phase::Off,
        "dim+off: dark at dim + additional");
    check(next_phase(Phase::Off, false, 999 * MIN, 999 * MIN, p) == Phase::Off, "dim+off: stays dark");
  }

  // A held finger pins every phase. This is what stops the screen dimming under
  // somebody who is reading it with a thumb resting on the glass.
  {
    const Policy p = policy_for("dim", 1, 1);
    check(next_phase(Phase::Awake, true, 999 * MIN, 0, p) == Phase::Awake, "hold: awake is pinned");
    check(next_phase(Phase::Dimmed, true, 999 * MIN, 999 * MIN, p) == Phase::Dimmed, "hold: dimmed is pinned");
    const Policy off = policy_for("off", 1, 0);
    check(next_phase(Phase::Awake, true, 999 * MIN, 0, off) == Phase::Awake, "hold: off-mode cannot go dark under a finger");
  }

  // The monotonic clock wraps after 49.7 days. The subtraction is unsigned, so
  // the elapsed time is right across the wrap.
  {
    check(elapsed_since(5u, 0xFFFFFFF0u) == 21u, "elapsed: wraps correctly");
    const uint32_t last = 0xFFFFFF00u;
    const uint32_t now = last + 5 * MIN;
    check(now < last, "elapsed: the test clock really wrapped");
    check(elapsed_since(now, last) == 5 * MIN, "elapsed: five minutes across the wrap is five minutes");
    const Policy p = policy_for("dim", 5, 0);
    check(next_phase(Phase::Awake, false, elapsed_since(now, last), 0, p) == Phase::Dimmed,
          "elapsed: the timeout fires across the wrap");
  }

  // Dimming never raises the brightness.
  {
    check(dim_percent(70, 20) == 20, "dim: 70 to 20");
    check(dim_percent(15, 20) == 15, "dim: a dim setting above the normal level leaves it alone");
    check(dim_percent(20, 20) == 20, "dim: equal levels stay equal");
    check(dim_percent(0, 0) == 1, "dim: zero clamps to the minimum, never to dark");
    check(dim_percent(101, 5) == 5, "dim: out-of-range input is clamped");
    check(dim_percent(50, 150) == 50, "dim: a 150% dim setting cannot brighten a 50% screen");
  }

  // The settings ranges.
  {
    check(minutes_to_ms(0, 30) == 30 * MIN, "minutes: zero falls back to the default");
    check(minutes_to_ms(-3, 30) == 30 * MIN, "minutes: negative falls back");
    check(minutes_to_ms(241, 0) == 240 * MIN, "minutes: the top is 240");
    check(minutes_to_ms(1, 0) == MIN, "minutes: one is one");
    check(minutes_to_ms(0, 0) == MIN, "minutes: a zero fallback still floors at one");
    check(policy_for("dim", 30, 0).off_ms == 0, "off-after: zero means never");
    check(policy_for("dim", 30, 1).off_ms == MIN, "off-after: one means one minute");
    check(policy_for("dim", 30, 240).off_ms == 240 * MIN, "off-after: the top is 240");
    check(!policy_for(nullptr, 30, 0).stay, "mode: a null mode is not stay");
  }

  // Repeated cycles: the policy holds no state, so a thousand cycles give the
  // same answers. This is what rules out a timer or a counter accumulating.
  {
    const Policy p = policy_for("dim", 1, 1);
    bool stable = true;
    for (int i = 0; i < 1000; i++) {
      stable = stable && next_phase(Phase::Awake, false, MIN, 0, p) == Phase::Dimmed;
      stable = stable && next_phase(Phase::Dimmed, false, 2 * MIN, MIN, p) == Phase::Off;
      stable = stable && next_phase(Phase::Off, false, 99 * MIN, 99 * MIN, p) == Phase::Off;
    }
    check(stable, "cycles: a thousand dim/off cycles give the same answers");
  }

  if (g_failures == 0) {
    std::printf("PASS %d checks\n", g_checks);
  } else {
    std::printf("FAILED %d of %d\n", g_failures, g_checks);
  }
  return g_failures == 0 ? 0 : 1;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-idle-"));
const driverPath = path.join(tmp, "idle_driver.cpp");
const exe = path.join(tmp, "idle_driver");
const cxx = process.env.CXX || "c++";
try {
  fs.writeFileSync(driverPath, driver);

  let runOk = false;
  let out = "";
  try {
    execFileSync(cxx, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", path.dirname(POLICY_H), driverPath, "-o", exe], {
      stdio: "pipe",
      encoding: "utf8",
    });
    out = execFileSync(exe, [], { stdio: "pipe", encoding: "utf8" });
    runOk = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
  }
  ok(runOk, "the policy header compiles and every native sequence passes", out.trim().slice(0, 600));
  ok(/^PASS \d+ checks/m.test(out.trim()), "the native driver reports its checks", out.trim().slice(0, 200));

  // The mutation: put the old "dim and stay dim" answer back for the second
  // delay. A gate that still passes against that is not testing this change.
  const mutantDir = path.join(tmp, "mutant");
  fs.mkdirSync(mutantDir);
  const policySource = read(POLICY_H);
  const oldAnswer = policySource.replace(
    "return since_dim_ms < p.off_ms ? Phase::Dimmed : Phase::Off;",
    "return Phase::Dimmed;  // the behaviour before this change: dim and stay dim",
  );
  ok(oldAnswer !== policySource, "the mutation target (the off delay) exists in the policy");
  fs.writeFileSync(path.join(mutantDir, "idle_policy.h"), oldAnswer);
  const mutantExe = path.join(tmp, "idle_driver_mutant");
  let mutantFailed = false;
  try {
    execFileSync(cxx, ["-std=c++17", "-I", mutantDir, driverPath, "-o", mutantExe], { stdio: "pipe" });
    execFileSync(mutantExe, [], { stdio: "pipe" });
  } catch {
    mutantFailed = true;
  }
  ok(mutantFailed, "the harness fails against the old 'dim and never turn off' behaviour — it has teeth");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4. The poll: settings changes reconcile, they never wake.
// ---------------------------------------------------------------------------
{
  ok(
    poll.includes("next_phase(s_idle_phase, s_idle_touch_held, elapsed, since_dim, policy)"),
    "the poll passes the held state to the policy — a finger on the glass is not idle time",
  );
  ok(!poll.includes("Phase::Awake"), "the poll itself can never enter Awake; only a touch does that");
  ok(poll.includes("apply_light_(true, target, IDLE_DIM_TRANSITION_MS);"), "a changed brightness or dim level is applied in place");
  ok(
    poll.includes("const auto &s = c->settings();") && poll.includes("s.idle_off_min"),
    "the policy is rebuilt from the current settings every tick",
  );
  ok(
    enter.includes("subwave_idle::dim_percent(normal, c == nullptr ? normal : c->settings().idle_pct)"),
    "dimming uses the lower of the normal level and the dim setting",
  );
  ok(
    poll.includes("subwave_idle::dim_percent(normal, s.idle_pct)"),
    "and so does the reconciliation path",
  );
  ok(
    init.includes("idle_enter_(subwave_idle::Phase::Awake, 0)") && init.includes("c->settings().idle_mode"),
    "boot starts awake at the configured level and logs the mode it read",
  );

  ok(
    manual.includes("if (s_idle_phase == subwave_idle::Phase::Off)") &&
      manual.indexOf("Phase::Off") < manual.indexOf("apply_light_("),
    "a brightness change while dark is stored for the next wake, not applied to a dark room",
  );
  ok(
    manual.includes("subwave_idle::dim_percent(percent") &&
      manual.indexOf("Phase::Dimmed") < manual.indexOf("apply_light_("),
    "a change while dimmed keeps the dim ceiling",
  );
  ok(
    scripts.includes("subwave_display::idle_set_manual_brightness(value);") &&
      !/id\(backlight\)/.test(
        scripts
          .slice(scripts.indexOf("- id: set_brightness_to"), scripts.indexOf("- id: theme_cycle"))
          .replace(/^\s*\/\/.*$/gm, ""),
      ),
    "the brightness row goes through the controller, not straight to the light",
  );
}

// ---------------------------------------------------------------------------
// 5. Artwork and the install.
// ---------------------------------------------------------------------------
{
  ok(
    effects.includes("s_ota_screen_applied_off || s_idle_phase == subwave_idle::Phase::Off"),
    "artwork effects are suspended both while off and while the install holds the panel",
  );
  ok(!/[^=!<>]=[^=]/.test(effects), "suspension is a pure read — the effects resume by themselves when the phase changes");
  ok(artTick.includes("!idle_effects_suspended()"), "and the artwork tick consults it before repainting");
  ok(
    !artTick.includes("idle_enter_") && !artTick.includes("idle_touch"),
    "the artwork tick cannot wake the screen as a side effect",
  );

  const guard = "if (s_ota_screen_wanted_off || s_ota_screen_applied_off) return;";
  for (const [name, fn] of [
    ["poll", poll],
    ["touch", touch],
    ["movement", move],
    ["manual brightness", manual],
  ] as const) {
    ok(fn.includes(guard), `${name}: the install's darkness takes precedence over touch and polling`);
  }
  // Release is the exception, and deliberately so: it must still drop the hold
  // and the shield, or an install that begins mid-gesture leaves an invisible
  // clickable rectangle over the panel. It touches no light and restarts no
  // timer while the install owns the screen.
  ok(
    release.indexOf("if (s_ota_screen_wanted_off || s_ota_screen_applied_off) {") > 0 &&
      release.indexOf("if (s_ota_screen_wanted_off || s_ota_screen_applied_off) {") <
        release.indexOf("s_idle_last_activity_ms = esphome::millis();") &&
      release
        .slice(
          release.indexOf("if (s_ota_screen_wanted_off || s_ota_screen_applied_off) {"),
          release.indexOf("s_idle_last_activity_ms = esphome::millis();"),
        )
        .includes("s_idle_wake_gesture = false;"),
    "release: the install's darkness wins, but the hold and the shield are still cleared",
  );
  ok(
    otaApply.includes("if (!s_ota_screen_applied_off) idle_reclaim_screen_();"),
    "an aborted or failed install hands the screen back to the controller",
  );
  ok(
    reclaim.includes("s_idle_phase = subwave_idle::Phase::Awake;") &&
      reclaim.includes("s_idle_last_activity_ms = esphome::millis();") &&
      reclaim.includes("lv_obj_add_flag(shield, LV_OBJ_FLAG_HIDDEN)"),
    "and the hand-back starts awake, with a fresh period and no shield",
  );
}

// ---------------------------------------------------------------------------
// 6. The When Idle dialog and its four settings.
// ---------------------------------------------------------------------------
{
  ok(settingsScreen.includes("script.execute: idle_dialog_open"), "the When Idle row opens the dialog");
  ok(
    display.includes("id: idle_modal") &&
      display.includes("id: btn_idle_stay") &&
      display.includes("id: btn_idle_dim") &&
      display.includes("id: btn_idle_off") &&
      display.includes("id: row_idle_min") &&
      display.includes("id: row_idle_pct") &&
      display.includes("id: row_idle_off"),
    "the dialog declares Behavior, the timeout, the dim level and the additional off delay",
  );
  ok(
    display.includes('text: "Turn off after another"'),
    "the second timeout is labelled as additional time, not as a second timer",
  );
  ok(
    refresh.includes('idle_set_row_hidden_(idle_widget_("row_idle_min"), stay)') &&
      refresh.includes('idle_set_row_hidden_(idle_widget_("row_idle_pct"), !dim)') &&
      refresh.includes('idle_set_row_hidden_(idle_widget_("row_idle_off"), !dim)'),
    "controls that cannot affect the chosen behavior are hidden, not left active",
  );
  ok(
    refresh.includes('lv_label_set_text(lbl, "Never")') && refresh.includes('lv_label_set_text(lbl, "Never");'),
    "the additional delay shows Never at zero",
  );
  ok(ui.includes("Dimming never raises the brightness"), "the dialog says what the dim level means above the normal level");
  ok(
    refresh.includes('if (modal == nullptr || lv_obj_has_flag(modal, LV_OBJ_FLAG_HIDDEN)) return;'),
    "a hidden dialog costs nothing on the settings repaint",
  );

  const modeSet = scripts.slice(scripts.indexOf("- id: idle_mode_set"), scripts.indexOf("- id: idle_min_step"));
  const minStep = scripts.slice(scripts.indexOf("- id: idle_min_step"), scripts.indexOf("- id: idle_pct_step"));
  const pctStep = scripts.slice(scripts.indexOf("- id: idle_pct_step"), scripts.indexOf("- id: idle_off_step"));
  const offStep = scripts.slice(scripts.indexOf("- id: idle_off_step"), scripts.indexOf("- id: idle_tick"));

  ok(
    modeSet.includes('mode == 0 ? "stay" : (mode == 2 ? "off" : "dim")'),
    "the three behavior buttons map to stay, dim and off",
  );
  ok(
    minStep.includes("if (next < 1) next = 1;") &&
      minStep.includes("if (next > 240) next = 240;") &&
      minStep.includes("current < 10 ? current + 1 : ((current / 5) + 1) * 5"),
    "the timeout steps by a minute near the short end and five above it, clamped to 1..240",
  );
  ok(
    pctStep.includes("if (next < 1) next = 1;") && pctStep.includes("if (next > 100) next = 100;"),
    "the dim level is an absolute percentage, clamped to 1..100",
  );
  ok(
    offStep.includes("next = delta > 0 ? 5 : 0;") &&
      offStep.includes("if (next < 0) next = 0;") &&
      offStep.includes("if (next > 240) next = 240;"),
    "the additional delay treats zero as Never and clamps to 0..240",
  );
  for (const [name, fn] of [
    ["mode", modeSet],
    ["timeout", minStep],
    ["dim level", pctStep],
    ["off delay", offStep],
  ] as const) {
    ok(fn.includes("c->settings_draft()") && fn.includes("c->push_settings(draft);"), `${name}: writes the draft and pushes it`);
    ok(fn.includes("subwave_display::settings_refresh();"), `${name}: repaints the row and the open dialog`);
  }
  ok(
    settingsRefresh.includes("s.idle_off_min > 0") && settingsRefresh.includes('"Dim after %d min · off +%d min"'),
    "the settings row states the additional delay it will actually use",
  );
  ok(binding.includes('bind_object("idle_modal", id(idle_modal));'), "the dialog is bound");
  ok(
    /subwave_display::ui_mark_ready\(\);[\s\S]*script\.execute: idle_boot/.test(binding),
    "the controller starts after every binding exists",
  );
  ok(scripts.includes("- id: idle_boot") && scripts.includes("subwave_display::idle_init();"), "boot goes through idle_boot");
}

// ---------------------------------------------------------------------------
// 7. The settings contract: defaults, validation, persistence, reset, parse.
// ---------------------------------------------------------------------------
{
  ok(/idleOffMin\s+Int\s+@default\(0\)/.test(schema), "the schema's additive column defaults to Never");
  ok(
    migration.includes('ALTER TABLE "Device" ADD COLUMN "idleOffMin" INTEGER NOT NULL DEFAULT 0;'),
    "the migration adds the same column with the same default",
  );
  const statements = migration.replace(/--.*$/gm, "");
  ok(
    !/\b(DROP|DELETE|UPDATE|ALTER COLUMN)\b/i.test(statements),
    "the migration is additive only — no table is rewitten and no row is lost",
  );

  ok(
    (service.match(/idleOffMin: row\.idleOffMin \?\? 0/g) ?? []).length === 1 &&
      (service.match(/offMin: row\.idleOffMin \?\? 0/g) ?? []).length === 1,
    "both the state payload's idle block and the settings payload default an older row to Never",
  );
  ok(
    service.includes("Math.max(0, Math.min(240, Math.round(patch.idleOffMin)))"),
    "the server clamps the additional delay to 0..240 and keeps zero as a real value",
  );
  ok(
    service.includes("idleOffMin: next.idleOffMin,"),
    "and persists it with the rest of the settings",
  );
  ok(types.includes("idleOffMin: number") && types.includes("offMin: number"), "the shared types carry the new field");
  ok(adminRoute.includes("idleOffMin: 0"), "a settings reset returns the screen to Never");

  ok(clientCpp.includes('int_at(idle, "offMin", res->settings.idle_off_min)'), "the firmware reads offMin from the state idle block");
  ok(
    clientCpp.includes('cJSON_AddNumberToObject(settings, "idleOffMin", std::clamp(cmd.settings.idle_off_min, 0, 240))'),
    "and pushes it back, clamped, when the dialog changes it",
  );
  ok(
    (clientH.match(/int idle_off_min = 0;/g) ?? []).length >= 2 &&
      clientH.includes("idle_off_min(s.idle_off_min)") &&
      clientH.includes("s.idle_off_min = idle_off_min;"),
    "the firmware settings structs default it to Never and copy it in both directions",
  );
  ok(
    clientCpp.includes('"offMin"') && !/idle_deadline_ms/.test(clientCpp),
    "the firmware has no leftover deadline wire field",
  );
}

console.log(`  ${passed}/${passed + failed} idle assertions passed`);
if (failed > 0) process.exit(1);
