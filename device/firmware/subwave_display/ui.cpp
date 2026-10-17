#include "ui.h"

#include <cstdio>
#include <string>

#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/components/wifi/wifi_component.h"
#include "esphome/components/network/util.h"
// There is no `light/light.h`. The call API lives in light_call.h and the state
// API in light_state.h; including the wrong name is a fatal error, not a warning.
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


int64_t station_now_ms() {
  auto *c = client();
  if (c == nullptr || c->server_now_ms() == 0) return esphome::millis();
  return c->server_now_ms();
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
  for (lv_obj_t *o : {OBJ(setup_screen), OBJ(sleep_hint)}) {
    lv_obj_set_style_bg_color(o, bg, LV_PART_MAIN);
  }
  lv_obj_set_style_bg_color(OBJ(shows_expanded), surface, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(settings_rule), rule, LV_PART_MAIN);

  // Tier 1, the voice. The presenter is full-contrast and the show is not,
  // because a presenter is a person and a show is a title.
  lv_obj_set_style_bg_color(OBJ(live_lamp), accent, LV_PART_MAIN);
  lv_obj_set_style_bg_color(OBJ(live_lamp_shows), accent, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(byline_presenter), text, LV_PART_MAIN);
  lv_obj_set_style_text_color(OBJ(byline_show), muted, LV_PART_MAIN);
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
                      OBJ(row_0_host), OBJ(row_1_host), OBJ(row_2_host), OBJ(row_3_host), OBJ(row_4_host),
                      OBJ(settings_title), OBJ(settings_clock), OBJ(val_wifi), OBJ(val_addr),
                      OBJ(val_model), OBJ(val_ver), OBJ(val_up), OBJ(lbl_brightness),
                      OBJ(lbl_brightness_value), OBJ(lbl_theme), OBJ(lbl_idle), OBJ(lbl_orientation),
                      OBJ(lbl_skip)}) {
    if (o) lv_obj_set_style_text_color(o, muted, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(row_0_name), OBJ(row_1_name), OBJ(row_2_name), OBJ(row_3_name), OBJ(row_4_name)}) {
    lv_obj_set_style_text_color(o, text, LV_PART_MAIN);
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
  if (c == nullptr) return;
  const auto &n = c->now_playing();
  const auto &b = c->byline();
  const auto &s = c->skip();

  // Empty rather than a placeholder. "Ready to broadcast" is the web player's
  // line for a player with nothing loaded; a wall with nothing on it should just
  // be empty, and the lamp going dim says why.
  lv_label_set_text(OBJ(byline_presenter), b.presenter.c_str());
  lv_label_set_text(OBJ(byline_show), b.show.c_str());

  // THE QUIET LINE. SubwaveDisplay::last_error_ was written in eight places and
  // read by nobody — a refused claim, a removed screen, a skip somebody else got
  // first, a malformed response. Every one of those was an event the screen had
  // decided was worth explaining, explained into an empty buffer.
  //
  // Cleared on an empty error rather than left to time out, so a transient
  // refusal does not sit on the wall for the rest of the broadcast.
  const char *err = c->last_error().c_str();
  lv_label_set_text(OBJ(status_line), err);

  char runway[32];
  // -1 is the "not known" sentinel; see Byline in client().h.
  if (b.ends_in_sec > 0) {
    int h = (int) (b.ends_in_sec / 3600), m = (int) ((b.ends_in_sec % 3600) / 60);
    // The web's own phrasing, so the wall and the browser agree.
    if (h > 0) snprintf(runway, sizeof(runway), "%dh %dm left", h, m);
    else snprintf(runway, sizeof(runway), "%dm left", m);
  } else {
    runway[0] = '\0';
  }
  lv_label_set_text(OBJ(byline_runway), runway);

  // The lamp is a light, so idle means dim rather than off: a display that has
  // lost its connection should still be visibly trying.
  lv_obj_set_style_opa(OBJ(live_lamp), n.live ? LV_OPA_COVER : LV_OPA_40, LV_PART_MAIN);

  lv_label_set_text(OBJ(track_title), n.title.c_str());
  lv_label_set_text(OBJ(track_artist), n.artist.c_str());

  char num[12];
  snprintf(num, sizeof(num), "%d", c->signed_in());
  lv_label_set_text(OBJ(count_signed_in), num);
  snprintf(num, sizeof(num), "%d", c->listening());
  lv_label_set_text(OBJ(count_listening), num);

  // Skip. The server sent a finished label; there is no policy here to get
  // wrong, only four strings to show. That is the entire point of sending the
  // label rather than a mode plus a listener count.
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
  // Placeholder rows until the schedule lands. A list that renders its frame
  // immediately and fills in is better than one that renders nothing, because a
  // screen showing nothing reads as broken rather than as loading.
  static bool painted = false;
  if (painted) return;
  painted = true;
  auto *c = client();
  if (c == nullptr) return;
  lv_label_set_text(OBJ(shows_station), c->state_station_name().c_str());
}

void settings_refresh() {
  auto *c = client();
  if (c == nullptr) return;
  const auto &s = c->settings();

  char buf[24];
  snprintf(buf, sizeof(buf), "%d%%", s.brightness);
  lv_label_set_text(OBJ(lbl_brightness_value), buf);
  // Unfilled segments are rule; filled are the accent. Tapping a segment sets
  // the level rather than dragging towards it, because dragging on glass on a
  // wall is a precise gesture nobody can make.
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

  // The settings screen's read-only facts. Someone WILL ask which network this
  // thing is on, and the answer should not require a serial cable and a laptop —
  // which is the whole reason these four rows exist.
  auto *wifi = esphome::wifi::global_wifi_component;
  if (wifi != nullptr && wifi->is_connected()) {
    // wifi_ssid_to(), NOT wifi_ssid(): the latter is deprecated and due for
    // removal in 2026.9, and this firmware should not start failing to build the
    // day ESPHome bumps its floor.
    char ssid[esphome::wifi::SSID_BUFFER_SIZE];
    lv_label_set_text(OBJ(val_wifi), wifi->wifi_ssid_to(ssid));
    for (const auto &addr : wifi->get_ip_addresses()) {
      if (addr.is_set()) {
        lv_label_set_text(OBJ(val_addr), addr.str().c_str());
        break;
      }
    }
    char sig[24];
    snprintf(sig, sizeof(sig), "%s %ddBm", ssid, (int) wifi->wifi_rssi());
    lv_label_set_text(OBJ(val_wifi), sig);
  }
  lv_label_set_text(OBJ(val_model), "JC8012P4A1");

  // Uptime, from the local millisecond counter. The station's clock is only a
  // reference; uptime is a fact about this device.
  uint32_t secs = esphome::millis() / 1000;
  char up[48];
  if (secs > 86400) snprintf(up, sizeof(up), "%d days %d hours", (int) (secs / 86400), (int) ((secs % 86400) / 3600));
  else if (secs > 3600) snprintf(up, sizeof(up), "%d hours %d minutes", (int) (secs / 3600), (int) ((secs % 3600) / 60));
  else snprintf(up, sizeof(up), "%d minutes", (int) (secs / 60));
  lv_label_set_text(OBJ(val_up), up);
}

void chrome_refresh() { /* the rail is drawn by window_draw_rail in theme.yaml */ }

/**
 * The screen going dark, and coming back.
 *
 * A two-second confirmation before blanking, and that confirmation is not
 * decoration: a black rectangle on a wall is indistinguishable from a broken
 * screen, so without it the most likely explanation a person reaches for is the
 * wrong one. It answers an action — the screen dimming itself — and nothing on
 * this device animates for its own sake.
 */
void idle_apply(bool asleep) {
  // ONE OWNER FOR THE ASLEEP STATE. The global existed, was declared in
  // setup.yaml and was bound across — and nothing read or wrote it, so the
  // screen had two possible answers to "is it asleep" and no way to tell which
  // was true. This function is the only thing that changes it.
  BOOL(screen_asleep) = asleep;

  if (asleep) {
    lv_obj_clear_flag(OBJ(sleep_hint), LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(OBJ(sleep_hint), "Screen off · tap anywhere to wake");
    return;
  }
  lv_obj_add_flag(OBJ(sleep_hint), LV_OBJ_FLAG_HIDDEN);
}

void idle_touch() {
  // Any touch wakes, and restarts the full timer. A track change, a show change
  // or a heartbeat deliberately do NOT: a screen nobody is touching should stay
  // as it is rather than lighting itself up in an empty room.
  idle_apply(false);
  U32(idle_deadline_ms) = (uint32_t) station_now_ms() + (uint32_t) (client()->settings().idle_min * 60000ULL);
}

}  // namespace subwave_display