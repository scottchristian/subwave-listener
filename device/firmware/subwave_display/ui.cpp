#include "ui.h"

#include <cstdio>
#include <string>

#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/core/defines.h"
#include "esphome/components/wifi/wifi_component.h"
#include "esphome/components/network/util.h"
// There is no `light/light.h`. The call API lives in light_call.h and the state
// API in light_state.h; including the wrong name is a fatal error, not a warning.
#include <ctime>

#include "esphome/components/light/light_call.h"
#include "esphome/components/light/light_state.h"
#include "display_client.h"

// LVGL object ids come from the YAML. They are declared here rather than pulled
// from a generated header because the whole point of pre-allocating all three
// window trees at boot is that they are static objects with fixed ids.
// THE PALETTE IS NOT WIDGETS. These six are `globals:` of `type: int` in
// theme.yaml — resolved colours, read by everything and written by apply_theme.
// Declaring them as lv_obj_t* made every lv_color_hex() below a
// pointer-to-integer conversion, and the error pointed at the colour maths
// rather than at the declaration that caused it.

// ---------------------------------------------------------------------------
namespace subwave_display {

static const char *const TAG = "subwave.ui";

// ---------------------------------------------------------------------------
// The bindings, and why they exist.
//
// ESPHome generates every LVGL widget id, every `globals:` entry and every
// component pointer into its own main.cpp as a `static` object:
//
//     static lv_obj_t *const id_live_lamp = ...;
//     static globals::GlobalsComponent<int> *const c_bg = ...;
//     static subwave_display::SubwaveDisplay *const display_client = ...;
//
// `static` is internal linkage, so no other translation unit can name them. An
// `extern int c_bg;` here compiles perfectly and then fails at LINK time with a
// page of undefined references — which is a very long way from the mistake, and
// the reason this file spent its first build looking for a generated header that
// does not exist and never will.
//
// So the pointers are handed over instead: one YAML lambda at boot calls the
// bind_* functions, and everything here reads them back BY NAME.
//
// A fixed table, not a map. This is a wall display with one screen and no
// general-purpose allocation; a 64-entry array of {name, pointer} pairs costs
// 512 bytes of static memory and does not touch the heap that PSRAM is already
// tight on. The size is checked rather than trusted — see the log line below.
// ---------------------------------------------------------------------------
struct Binding {
  const char *name;
  void *ptr;
};

static constexpr size_t MAX_BINDINGS = 128;
static Binding g_bindings[MAX_BINDINGS];
static size_t g_binding_count = 0;
static SubwaveDisplay *g_client = nullptr;
// The backlight, handed over from YAML. Held raw rather than looked up by name
// because it is a light component and not a widget, so it never goes near the
// widget binding table.
static esphome::light::LightState *g_backlight = nullptr;

// The "off" sequence has a second phase, and it needs somewhere to wait. ESPHome
// 2026.7 has no App.schedule_timeout — the Application class has no timeout API
// at all — so the delay is a deadline checked by the same tick that arms the
// idle timer. See idle_poll().
static uint32_t g_blank_at = 0;
static bool g_blank_pending = false;

// Whether the binding table is populated. Set by ui_mark_ready() once YAML has
// handed over every widget.
//
// EVERY PAINTER IS NULL UNTIL THEN, AND THAT IS NOT A THEORETICAL WINDOW. The
// first state poll can land before bind_widgets' one-second delay expires — the
// screen is on a working network, the server answers in a few hundred
// milliseconds — and the painter would dereference null on each of its twenty
// labels. The guard is one flag rather than a null check at every call site
// because a missed one is a crash and the twenty call sites are exactly where
// one gets missed.
static bool g_ui_ready = false;

static void bind_raw(const char *name, void *ptr) {
  if (ptr == nullptr) return;  // already reported by the caller
  if (g_binding_count >= MAX_BINDINGS) {
    ESP_LOGE(TAG, "Binding table is full at %u entries; '%s' was dropped.", (unsigned) MAX_BINDINGS, name);
    return;
  }
  g_bindings[g_binding_count++] = Binding{name, ptr};
}

void bind_object(const char *name, lv_obj_t *obj) { bind_raw(name, (void *) obj); }
void bind_int(const char *name, int *value) { bind_raw(name, (void *) value); }
void bind_bool(const char *name, bool *value) { bind_raw(name, (void *) value); }
void bind_uint32(const char *name, uint32_t *value) { bind_raw(name, (void *) value); }
void bind_client(SubwaveDisplay *client) { g_client = client; }

static void *lookup(const char *name) {
  for (size_t i = 0; i < g_binding_count; i++) {
    if (strcmp(g_bindings[i].name, name) == 0) return g_bindings[i].ptr;
  }
  ESP_LOGE(TAG, "'%s' was never bound. Check the bind_widgets script.", name);
  return nullptr;
}

void ui_mark_ready() {
  g_ui_ready = true;
  shows_refresh();
  settings_refresh();
}

void bindings_report_missing() {
  // One line, not one per object: a half-bound screen should say so once rather
  // than filling the log with the same complaint on every repaint.
  ESP_LOGI(TAG, "Bound %u object(s).", (unsigned) g_binding_count);
  if (g_client == nullptr) {
    ESP_LOGE(TAG, "No display_client bound — the screen cannot show anything.");
  }
}

#define OBJ(name) ((lv_obj_t *) lookup(#name))
#define INT(name) (*(int *) lookup(#name))
#define BOOL(name) (*(bool *) lookup(#name))
#define U32(name) (*(uint32_t *) lookup(#name))
#define client() (g_client)

/**
 * True once the widgets exist.
 *
 * Spelled as a function rather than `#define ready() g_ui_ready` so that the
 * dead-code gate can see the name `ui_ready` used at a call site and treat it as
 * an edge. A macro would be invisible to it.
 */
bool ui_ready() { return g_ui_ready; }


/**
 * The station's clock, in milliseconds.
 *
 * The server's time, never SNTP and never the local counter. A screen with no RTC
 * drifts, and a wall display whose schedule is two minutes out is worse than one
 * showing nothing — so the station is the authority and every poll brings the
 * device's idea of the time back into line with it. The local counter is only the
 * fallback for the first seconds after boot, before the first poll has landed.
 *
 * NOT A PAINTER, AND NOT A TIMER. This is a reading, so that the painters that
 * need a clock and the interval that drives them can disagree about nothing.
 */
int64_t station_now_ms() {
  auto *c = client();
  if (c == nullptr || c->server_now_ms() == 0) return (int64_t) esphome::millis();
  return c->server_now_ms();
}

/**
 * The clock in the top-right of the settings screen.
 *
 * ITS OWN ONE-SECOND INTERVAL, NOT THE POLL AND NOT THE IDLE TICK. Those are both
 * wrong in opposite directions: the poll is up to ten seconds apart, so a clock
 * fed from it steps visibly and is wrong to within ten seconds most of the time,
 * and the idle tick is five, which is worse. One `text` write a second is
 * nothing — the label is thirty glyphs — and it is the only way a clock is a
 * clock rather than a field report.
 *
 * IT WAS DEAD, LIKE MOST OF THIS SCREEN. station_now_ms() existed, and
 * settings_clock was bound, and neither was ever connected to anything, so the
 * label showed the empty string its YAML declared. See skip_press in
 * scripts.yaml and parse_state_ in display_client.cpp for the rest of this
 * family; three separate features were built, bound and never switched on.
 */
void clock_refresh() {
  if (!ui_ready()) return;
  const int64_t ms = station_now_ms();

  // UTC, because that is what the server sends. A wall display has no timezone
  // setting and never had one — the screen is in somebody's hallway, not in
  // their pocket — so local time would need a guess, and a wrong guess on a
  // clock is worse than a plainly-labelled one.
  const time_t secs = (time_t) (ms / 1000);
  struct tm tm_utc;
  gmtime_r(&secs, &tm_utc);

  char buf[16];
  strftime(buf, sizeof(buf), "%H:%M", &tm_utc);
  lv_label_set_text(OBJ(settings_clock), buf);
}

/**
 * Every colour in the design, applied in one place.
 *
 * The DAY/night difference is luminance only. The accent keeps its hue and
 * changes value, because warming it toward the app's brass at night would
 * overload brass — which is reserved, throughout this product, for meaning
 * "operator attention" and nothing else.
 */
void theme_paint_all() {
  auto bg = lv_color_hex(INT(c_bg));
  auto surface = lv_color_hex(INT(c_surface));
  auto text = lv_color_hex(INT(c_text));
  auto muted = lv_color_hex(INT(c_muted));
  auto rule = lv_color_hex(INT(c_rule));
  auto accent = lv_color_hex(INT(c_accent));

  // Window backgrounds. Each window paints its own, so switching one does not
  // have to repaint the others.
  for (lv_obj_t *w : {OBJ(window_0), OBJ(window_1), OBJ(window_2)}) {
    lv_obj_set_style_bg_color(w, bg, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(setup_wifi_screen), OBJ(sleep_hint)}) {
    lv_obj_set_style_bg_color(o, bg, LV_PART_MAIN);
  }
  lv_obj_set_style_bg_color(OBJ(shows_expanded), surface, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(settings_rule), rule, LV_PART_MAIN);

  // Tier 1, the voice.
  lv_obj_set_style_bg_color(OBJ(live_lamp), accent, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(live_lamp_shows), accent, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(byline_presenter), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(byline_show), accent, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(byline_runway), muted, LV_PART_MAIN);

  lv_obj_set_style_text_color(OBJ(track_title), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(track_artist), muted, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(now_rule), rule, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(art_out), surface, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(art_in), surface, LV_PART_MAIN);

  lv_obj_set_style_text_color(OBJ(count_signed_in), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(count_listening), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(count_signed_label), muted, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(count_listening_label), muted, LV_PART_MAIN);

  lv_obj_set_style_text_color(OBJ(shows_station), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(shows_day), muted, LV_PART_MAIN);
  for (lv_obj_t *o : {OBJ(expanded_host)}) lv_obj_set_style_text_color(o, text, LV_PART_MAIN);
  for (lv_obj_t *o : {OBJ(expanded_tagline)}) lv_obj_set_style_text_color(o, muted, LV_PART_MAIN);

  for (lv_obj_t *o : {OBJ(row_0_time), OBJ(row_1_time), OBJ(row_2_time), OBJ(row_3_time), OBJ(row_4_time),
                      OBJ(lbl_brightness_value), OBJ(lbl_theme), OBJ(lbl_idle), OBJ(lbl_orientation),
                      OBJ(lbl_skip)}) {
    if (o) lv_obj_set_style_text_color(o, accent, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(row_0_host), OBJ(row_1_host), OBJ(row_2_host), OBJ(row_3_host), OBJ(row_4_host),
                      OBJ(settings_clock)}) {
    if (o) lv_obj_set_style_text_color(o, muted, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(row_0_name), OBJ(row_1_name), OBJ(row_2_name), OBJ(row_3_name), OBJ(row_4_name),
                      OBJ(settings_title), OBJ(lbl_brightness), OBJ(val_wifi), OBJ(val_addr),
                      OBJ(val_model), OBJ(val_ver), OBJ(val_up)}) {
    if (o) lv_obj_set_style_text_color(o, text, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(row_0_rule), OBJ(row_1_rule), OBJ(row_2_rule), OBJ(row_3_rule), OBJ(row_4_rule)}) {
    lv_obj_set_style_bg_color(o, rule, LV_PART_MAIN);
  }

  // Brightness segments. Unfilled segments stay at rule, not muted, so the bar
  // reads as one object with a level rather than as ten separate switches.
  for (int i = 0; i < 10; i++) {
    lv_obj_t *seg = (i == 0) ? OBJ(seg_0) : (i == 1) ? OBJ(seg_1) : (i == 2) ? OBJ(seg_2)
                 : (i == 3) ? OBJ(seg_3) : (i == 4) ? OBJ(seg_4) : (i == 5) ? OBJ(seg_5)
                 : (i == 6) ? OBJ(seg_6) : (i == 7) ? OBJ(seg_7) : (i == 8) ? OBJ(seg_8) : OBJ(seg_9);
    if (seg) lv_obj_set_style_bg_color(seg, rule, LV_PART_MAIN);
  }
}

/** Window 1. The three tiers, plus the Skip button the server already decided on. */
void now_refresh() {
  auto *c = client();
  if (c == nullptr || !ui_ready()) return;
  const auto &n = c->now_playing();
  const auto &b = c->byline();
  const auto &s = c->skip();

  const std::string station = c->state_station_name().empty() ? "SUB/WAVE RADIO" : c->state_station_name();
  const char *presenter_text = !b.presenter.empty() ? b.presenter.c_str() : station.c_str();
  const char *show_text = !b.show.empty() ? b.show.c_str() : (n.live ? "Live Broadcast" : "24/7 Station Stream");
  lv_label_set_text(OBJ(byline_presenter), presenter_text);
  lv_label_set_text(OBJ(byline_show), show_text);

  const char *err = c->last_error().c_str();
  lv_label_set_text(OBJ(status_line), err);

  char runway[32];
  if (b.ends_in_sec > 0) {
    int h = (int) (b.ends_in_sec / 3600), m = (int) ((b.ends_in_sec % 3600) / 60);
    if (h > 0) snprintf(runway, sizeof(runway), "%dh %dm left", h, m);
    else snprintf(runway, sizeof(runway), "%dm left", m);
  } else {
    snprintf(runway, sizeof(runway), "%s", n.live ? "ON AIR NOW" : "AUTO DJ");
  }
  lv_label_set_text(OBJ(byline_runway), runway);

  lv_obj_set_style_opa(OBJ(live_lamp), n.live ? LV_OPA_COVER : LV_OPA_40, LV_PART_MAIN);

  lv_label_set_text(OBJ(track_title), !n.title.empty() ? n.title.c_str() : "Station Stream Active");
  lv_label_set_text(OBJ(track_artist), !n.artist.empty() ? n.artist.c_str() : station.c_str());

  char num[12];
  snprintf(num, sizeof(num), "%d", c->signed_in());
  lv_label_set_text(OBJ(count_signed_in), num);
  snprintf(num, sizeof(num), "%d", c->listening());
  lv_label_set_text(OBJ(count_listening), num);

  bool show = s.shown && c->settings().skip_enabled;
  if (show) {
    lv_obj_clear_flag(OBJ(btn_skip), LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(OBJ(btn_skip_label), s.label.c_str());
    lv_obj_set_style_opa(OBJ(btn_skip), s.enabled ? LV_OPA_COVER : LV_OPA_40, LV_PART_MAIN);
  } else {
    lv_obj_add_flag(OBJ(btn_skip), LV_OBJ_FLAG_HIDDEN);
  }
}

void shows_refresh() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;

  std::string station = c->state_station_name().empty() ? "SUB/WAVE SCHEDULE" : c->state_station_name();
  lv_label_set_text(OBJ(shows_station), station.c_str());

  std::string day = c->schedule_day_label().empty() ? "ON AIR & UP NEXT" : c->schedule_day_label();
  lv_label_set_text(OBJ(shows_day), day.c_str());

  lv_obj_t *row_times[5] = {OBJ(row_0_time), OBJ(row_1_time), OBJ(row_2_time), OBJ(row_3_time), OBJ(row_4_time)};
  lv_obj_t *row_names[5] = {OBJ(row_0_name), OBJ(row_1_name), OBJ(row_2_name), OBJ(row_3_name), OBJ(row_4_name)};
  lv_obj_t *row_hosts[5] = {OBJ(row_0_host), OBJ(row_1_host), OBJ(row_2_host), OBJ(row_3_host), OBJ(row_4_host)};

  const auto &slots = c->schedule_slots();
  if (!slots.empty()) {
    for (int i = 0; i < 5; i++) {
      if (i < (int) slots.size()) {
        const auto &slot = slots[i];
        std::string time_lbl = slot.from;
        if (!slot.to.empty()) time_lbl += " – " + slot.to;
        if (slot.live) time_lbl = "LIVE · " + time_lbl;
        lv_label_set_text(row_times[i], time_lbl.c_str());
        lv_label_set_text(row_names[i], slot.name.empty() ? "Auto DJ" : slot.name.c_str());
        lv_label_set_text(row_hosts[i], slot.host.empty() ? "Station Rotation" : slot.host.c_str());
      } else {
        lv_label_set_text(row_times[i], "—");
        lv_label_set_text(row_names[i], "");
        lv_label_set_text(row_hosts[i], "");
      }
    }
    return;
  }

  // Fallback when schedule endpoint hasn't populated yet: reflect current byline in row 0.
  const auto &b = c->byline();
  if (!b.show.empty() || !b.presenter.empty()) {
    lv_label_set_text(row_times[0], b.live ? "LIVE NOW" : "NOW ON AIR");
    lv_label_set_text(row_names[0], !b.show.empty() ? b.show.c_str() : "Live Broadcast");
    lv_label_set_text(row_hosts[0], !b.presenter.empty() ? b.presenter.c_str() : station.c_str());
  }
}

void settings_refresh() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;
  const auto &s = c->settings();

  char buf[24];
  snprintf(buf, sizeof(buf), "%d%%", s.brightness);
  lv_label_set_text(OBJ(lbl_brightness_value), buf);
  for (int i = 0; i < 10; i++) {
    bool on = (i + 1) * 10 <= s.brightness;
    lv_obj_t *seg = (i == 0) ? OBJ(seg_0) : (i == 1) ? OBJ(seg_1) : (i == 2) ? OBJ(seg_2)
                 : (i == 3) ? OBJ(seg_3) : (i == 4) ? OBJ(seg_4) : (i == 5) ? OBJ(seg_5)
                 : (i == 6) ? OBJ(seg_6) : (i == 7) ? OBJ(seg_7) : (i == 8) ? OBJ(seg_8) : OBJ(seg_9);
    if (seg) lv_obj_set_style_bg_color(seg, on ? lv_color_hex(INT(c_accent)) : lv_color_hex(INT(c_rule)), LV_PART_MAIN);
  }

  lv_label_set_text(OBJ(lbl_theme), s.theme_mode == "auto" ? "Follow the sun" : (s.theme_mode == "day" ? "Always day" : "Always night"));
  const char *idle = s.idle_mode == "stay" ? "Stay on" : (s.idle_mode == "dim" ? "Dim" : "Off");
  char idle_buf[64];
  snprintf(idle_buf, sizeof(idle_buf), "%s, after %d minutes", idle, s.idle_min);
  lv_label_set_text(OBJ(lbl_idle), idle_buf);
  lv_label_set_text(OBJ(lbl_orientation), s.orientation == "portrait" ? "Portrait — restarts" : "Landscape");
  lv_label_set_text(OBJ(lbl_skip), s.skip_enabled ? "Allowed" : "Hidden");

  auto *wifi = esphome::wifi::global_wifi_component;
  if (wifi != nullptr && wifi->is_connected()) {
    char ssid[esphome::wifi::SSID_BUFFER_SIZE];
    wifi->wifi_ssid_to(ssid);
    for (const auto &addr : wifi->get_ip_addresses()) {
      if (addr.is_set()) {
        lv_label_set_text(OBJ(val_addr), addr.str().c_str());
        break;
      }
    }
    char sig[48];
    snprintf(sig, sizeof(sig), "%s (%ddBm)", ssid, (int) wifi->wifi_rssi());
    lv_label_set_text(OBJ(val_wifi), sig);
  } else {
    lv_label_set_text(OBJ(val_wifi), "Not connected");
    lv_label_set_text(OBJ(val_addr), "—");
  }
  lv_label_set_text(OBJ(val_model), "JC8012P4A1");
#ifdef ESPHOME_PROJECT_VERSION
  lv_label_set_text(OBJ(val_ver), ESPHOME_PROJECT_VERSION);
#else
  lv_label_set_text(OBJ(val_ver), "1.11.0");
#endif

  // Uptime, from the local millisecond counter. The station's clock is only a
  // reference; uptime is a fact about this device.
  uint32_t secs = esphome::millis() / 1000;
  char up[48];
  if (secs > 86400) snprintf(up, sizeof(up), "%d days %d hours", (int) (secs / 86400), (int) ((secs % 86400) / 3600));
  else if (secs > 3600) snprintf(up, sizeof(up), "%d hours %d minutes", (int) (secs / 3600), (int) ((secs % 3600) / 60));
  else snprintf(up, sizeof(up), "%d minutes", (int) (secs / 60));
  lv_label_set_text(OBJ(val_up), up);
}

/**
 * The screen going dark, and coming back.
 *
 * A two-second confirmation before blanking, and that confirmation is not
 * decoration: a black rectangle on a wall is indistinguishable from a broken
 * screen, so without it the most likely explanation a person reaches for is the
 * wrong one. It answers an action — the screen dimming itself — and nothing on
 * this device animates for its own sake.
 */
void bind_backlight(esphome::light::LightState *light) { g_backlight = light; }

void idle_apply(bool asleep) {
  auto *c = client();
  if (c == nullptr || !ui_ready()) return;

  // ONE OWNER FOR THE ASLEEP STATE. The global existed, was declared in
  // setup.yaml and was bound across — and nothing read or wrote it, so the
  // screen had two possible answers to "is it asleep" and no way to tell which
  // was true. This function is the only thing that changes it.
  BOOL(screen_asleep) = asleep;

  // THE BACKLIGHT IS WHAT ACTUALLY DIMS. Showing a label over a still-lit screen
  // is not a screen going off, and the first version did exactly that.
  if (g_backlight == nullptr) return;

  auto dim_to = [&](float pct, uint32_t transition_ms) {
    auto call = g_backlight->make_call();
    call.set_brightness(pct / 100.0f);
    call.set_transition_length(transition_ms);
    call.perform();
  };

  if (!asleep) {
    // CANCEL THE PENDING BLANK. Without this a tap during the 2.5s "screen off"
    // message wakes the screen and then, a moment later, the blank lands anyway
    // and the wake silently fails. It is the kind of bug that reads as "touch
    // does not work" and nothing in the log says why.
    g_blank_pending = false;
    lv_obj_add_flag(OBJ(sleep_hint), LV_OBJ_FLAG_HIDDEN);
    // Ramped, not a hard cut. A jump from black to full brightness is unpleasant
    // in a dark room, and the ramp is what makes it read as waking rather than as
    // a different screen appearing.
    dim_to(100, 800);
    return;
  }

  // THREE MODES, ONE CHOICE. See device/design.md's idle section — and note that
  // there is no audio on this device, so there is no user activity to measure.
  // "Waking is touch-only" follows from that: a track change or a heartbeat must
  // not light up a screen in an empty room.
  const std::string mode = c->settings().idle_mode;
  ESP_LOGI(TAG, "idle_apply(asleep=%d) mode=%s idle_min=%u idle_pct=%d", asleep ? 1 : 0, mode.c_str(), c->settings().idle_min, c->settings().idle_pct);
  if (mode == "stay") {
    dim_to(100, 0);
    return;
  }
  if (mode == "dim") {
    lv_obj_add_flag(OBJ(sleep_hint), LV_OBJ_FLAG_HIDDEN);
    // 8 SECONDS IS THE RAMP, AND THE RAMP IS THE CONFIRMATION — you watch it
    // happen. design.md is explicit that this is not a transition to hide.
    dim_to((float) c->settings().idle_pct, 8000);
    return;
  }

  // "off": drop partway, say so, then blank. The message is what tells somebody
  // standing there that the screen has not failed — a black rectangle on a wall
  // is indistinguishable from a broken one.
  dim_to(20, 1000);
  lv_obj_clear_flag(OBJ(sleep_hint), LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(OBJ(sleep_hint), "Screen off \u00b7 tap anywhere to wake");
  // Arm the second phase rather than schedule it. Same reason as the tick: the
  // deadline is data, not a timer that has to be torn down on wake.
  g_blank_at = (uint32_t) esphome::millis() + 2500u;
  g_blank_pending = true;
}

void idle_touch() {
  // Any touch wakes, and restarts the full timer. A track change, a show change
  // or a heartbeat deliberately do NOT: a screen nobody is touching should stay
  // as it is rather than lighting itself up in an empty room.
  //
  // esphome::millis(), NOT station_now_ms(). It used to be the server's clock,
  // which made the idle deadline depend on the server answering — a screen that
  // could not reach the station would never time out — and it jumps when the
  // server's does, which would blank the screen early or never.
  idle_apply(false);
  auto *c = client();
  const uint32_t minutes = c == nullptr || c->settings().idle_min == 0 ? 9999u : (uint32_t) c->settings().idle_min;
  const std::string mode = c == nullptr ? std::string("stay") : c->settings().idle_mode;
  ESP_LOGI(TAG, "Idle deadline: %u minutes, mode=%s", minutes, mode.c_str());
  U32(idle_deadline_ms) = (uint32_t) esphome::millis() + minutes * 60000u;
}

/**
 * The idle tick. Asks one question and does whichever phase of the idle sequence
 * has come due. Called from the YAML interval every five seconds.
 *
 * ONE POLL, TWO PHASES, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING.
 *
 * The blank is checked first because the "off" sequence is two steps separated
 * by 2.5 seconds — drop to 20%, say so, then blank — and if the expire check ran
 * first it would see the deadline already passed and start the sequence all over
 * again on every tick, holding the screen at 20% forever and never blanking.
 *
 * THERE IS NO TIMER HERE, and that is deliberate twice over. ESPHome 2026.7's
 * Application has no timeout scheduling at all, so a deferred call has to be a
 * deadline checked by the next tick. And a self-rescheduling timer would have to
 * be cancelled and rebuilt on every wake, which is the shape of bug that outlives
 * the firmware. A poll cannot leave a timer behind.
 */
void idle_poll() {
  // Same reason as the painters: the deadline and the asleep flag are bound
  // objects, so reading them before ui_mark_ready() is a null dereference. The
  // interval's startup_delay keeps this from mattering in practice; the guard is
  // here so that moving that delay can never turn into a crash.
  if (!ui_ready()) return;
  // Phase two: the blank is due.
  if (g_blank_pending) {
    // Unsigned subtraction, deliberately: millis() wraps every 49 days and the
    // naive `millis() > deadline` form gets a wrap wrong for the whole of the
    // following period.
    if ((int32_t) (esphome::millis() - g_blank_at) >= 0) {
      g_blank_pending = false;
      if (g_backlight != nullptr)
        g_backlight->make_call().set_brightness(0.0f).perform();
      ESP_LOGI(TAG, "Blanked. Touch to wake.");
    }
    return;
  }

  if (BOOL(screen_asleep)) return;
  const uint32_t deadline = U32(idle_deadline_ms);
  // ZERO MEANS NOT ARMED. At boot there is no deadline until the first touch, so
  // the tick has to be able to tell "not armed" from "armed at millis() == 0".
  if (deadline == 0) {
    ESP_LOGD(TAG, "idle_poll: deadline==0, not armed");
    return;
  }
  if ((int32_t) (esphome::millis() - deadline) < 0) {
    ESP_LOGD(TAG, "idle_poll: deadline not yet reached, deadline=%u now=%u", deadline, esphome::millis());
    return;
  }

  ESP_LOGI(TAG, "Idle deadline passed; applying mode.");
  idle_apply(true);
}

}  // namespace subwave_display