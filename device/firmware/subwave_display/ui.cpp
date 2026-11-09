#include "ui.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <sys/time.h>

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
static uint32_t s_touch_counter = 0;

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

// Was 128. The firmware dialog added twelve objects (a card that must be
// repainted, not a static decoration), and a table that fills silently drops
// the last binding — which would leave one widget unbound with only an error in
// the log. The extra headroom is cheaper than a wrong log line at boot.
static constexpr size_t MAX_BINDINGS = 160;
static Binding g_bindings[MAX_BINDINGS];
static size_t g_binding_count = 0;
static SubwaveDisplay *g_client = nullptr;
// The backlight, handed over from YAML. Held raw rather than looked up by name
// because it is a light component and not a widget, so it never goes near the
// widget binding table.
static esphome::light::LightState *g_backlight = nullptr;

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

#define OBJ(name) ((lv_obj_t *) lookup(#name))
#define INT(name) (*(int *) lookup(#name))
#define BOOL(name) (*(bool *) lookup(#name))
#define U32(name) (*(uint32_t *) lookup(#name))
#define client() (g_client)

static bool g_art_effects_active = false;
static uint32_t g_art_effects_ms = 0;

static void art_effects_tick(lv_timer_t *timer) {
  auto *obj = static_cast<lv_obj_t *>(lv_timer_get_user_data(timer));
  auto *c = client();
  bool active = false;
  if (ui_ready() && c != nullptr && !c->stream_idle() && lv_obj_is_visible(obj)) {
    for (auto *cover : {OBJ(art_in), OBJ(art_out)}) {
      if (!lv_obj_has_flag(cover, LV_OBJ_FLAG_HIDDEN) && lv_image_get_src(cover) != nullptr &&
          lv_obj_get_style_opa(cover, LV_PART_MAIN) > LV_OPA_MIN) {
        active = true;
        break;
      }
    }
  }
  bool was_active = g_art_effects_active;
  g_art_effects_active = active;
  if (active || was_active) {
    g_art_effects_ms = lv_tick_get();
    lv_obj_invalidate(obj);
  }
}

static void art_effects_draw(lv_event_t *event) {
  if (!g_art_effects_active) return;
  auto *obj = lv_event_get_target_obj(event);
  auto *layer = lv_event_get_layer(event);
  lv_area_t bounds;
  lv_obj_get_coords(obj, &bounds);
  const lv_area_t saved_clip = layer->_clip_area;
  // Ancestor post-draw callbacks can inherit a redraw region larger than the artwork.
  lv_area_t clip = {std::max(saved_clip.x1, bounds.x1), std::max(saved_clip.y1, bounds.y1),
                    std::min(saved_clip.x2, bounds.x2), std::min(saved_clip.y2, bounds.y2)};
  if (clip.x1 > clip.x2 || clip.y1 > clip.y2) return;
  layer->_clip_area = clip;

  const int32_t width = lv_area_get_width(&bounds);
  const int32_t height = lv_area_get_height(&bounds);
  lv_draw_arc_dsc_t ring;
  lv_draw_arc_dsc_init(&ring);
  ring.center = {bounds.x1 + width / 2, bounds.y1 + height / 2};
  ring.width = 2;
  ring.color = lv_color_hex(INT(c_accent));
  ring.start_angle = 0;
  ring.end_angle = 360;
  for (int i = 0; i < 4; i++) {
    float phase = ((g_art_effects_ms + 3200 - i * 450) % 3200) / 3200.0f;
    float remaining = 1.0f - phase;
    float scale = 0.86f + 0.26f * (1.0f - remaining * remaining * remaining);
    float opacity = phase < 0.25f ? phase / 0.25f : remaining / 0.75f;
    ring.radius = static_cast<uint16_t>(width * (1.04f + i * 0.12f) * scale / 2.0f);
    ring.opa = static_cast<lv_opa_t>((0.30f - i * 0.05f) * 255 * opacity);
    lv_draw_arc(layer, &ring);
  }

  float phase = (g_art_effects_ms % 4500) / 4500.0f;
  float position = phase * phase * (3.0f - 2.0f * phase);
  float opacity = 1.0f;
  if (phase < 0.12f) {
    opacity = phase / 0.12f;
  } else if (phase > 0.88f) {
    opacity = (1.0f - phase) / 0.12f;
  }
  int32_t top = bounds.y1 + static_cast<int32_t>(height * (-0.25f + 1.35f * position));
  int32_t half_height = height * 11 / 100;
  lv_draw_rect_dsc_t sweep;
  lv_draw_rect_dsc_init(&sweep);
  sweep.bg_color = lv_color_white();
  sweep.bg_opa = static_cast<lv_opa_t>(26 * opacity);
  sweep.bg_grad.dir = LV_GRAD_DIR_VER;
  sweep.bg_grad.stops_count = 2;
  sweep.bg_grad.stops[0].color = lv_color_white();
  sweep.bg_grad.stops[0].frac = 0;
  sweep.bg_grad.stops[0].opa = LV_OPA_TRANSP;
  sweep.bg_grad.stops[1].color = lv_color_white();
  sweep.bg_grad.stops[1].frac = 255;
  sweep.bg_grad.stops[1].opa = LV_OPA_COVER;
  lv_area_t band = {bounds.x1, top, bounds.x2, top + half_height - 1};
  lv_draw_rect(layer, &sweep, &band);
  band.y1 += half_height;
  band.y2 += half_height;
  sweep.bg_grad.stops[0].opa = LV_OPA_COVER;
  sweep.bg_grad.stops[1].opa = LV_OPA_TRANSP;
  lv_draw_rect(layer, &sweep, &band);
  layer->_clip_area = saved_clip;
}

void ui_mark_ready() {
  g_ui_ready = true;
  lv_obj_add_event_cb(OBJ(art_layers), art_effects_draw, LV_EVENT_DRAW_POST, nullptr);
  lv_timer_create(art_effects_tick, 33, OBJ(art_layers));
  if (auto *c = client()) {
    if (lv_obj_t *ssid_lbl = OBJ(setup_wifi_value)) {
      lv_label_set_text(ssid_lbl, c->setup_ap_ssid().c_str());
    }
    if (lv_obj_t *pass_lbl = OBJ(setup_password_value)) {
      lv_label_set_text(pass_lbl, c->setup_ap_pass().c_str());
    }
    if (lv_obj_t *qr = OBJ(setup_qr)) {
      std::string wifi_qr = "WIFI:T:WPA;S:" + c->setup_ap_ssid() + ";P:" + c->setup_ap_pass() + ";;";
      lv_qrcode_update(qr, wifi_qr.c_str(), wifi_qr.size());
    }
  }
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
 * Reads the system clock synced via public SNTP servers (0/1/2.pool.ntp.org)
 * when valid (> 2023-11-14 UTC), falling back to the station's interpolated
 * serverNowMs timestamp, and finally the local millisecond counter right after
 * boot before SNTP or the first poll has landed.
 */
int64_t station_now_ms() {
  struct timeval tv {};
  if (::gettimeofday(&tv, nullptr) == 0 && tv.tv_sec > 1700000000) {
    return static_cast<int64_t>(tv.tv_sec) * 1000LL + static_cast<int64_t>(tv.tv_usec / 1000);
  }
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
  lv_obj_set_style_bg_color(OBJ(now_avatar_well), surface, LV_PART_MAIN);
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
                      OBJ(lbl_skip), OBJ(lbl_clear_cache)}) {
    if (o) lv_obj_set_style_text_color(o, accent, LV_PART_MAIN);
  }
  for (lv_obj_t *o : {OBJ(row_0_host), OBJ(row_1_host), OBJ(row_2_host), OBJ(row_3_host), OBJ(row_4_host),
                      OBJ(settings_clock), OBJ(lbl_cache_stats)}) {
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

  // Presenter detail modal overlay
  if (auto *obj = OBJ(presenter_card)) {
    lv_obj_set_style_bg_color(obj, surface, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(presenter_rule)) {
    lv_obj_set_style_bg_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(presenter_avatar_well)) {
    lv_obj_set_style_bg_color(obj, surface, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(btn_presenter_close)) {
    lv_obj_set_style_bg_color(obj, surface, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(presenter_name)) lv_obj_set_style_text_color(obj, text, LV_PART_MAIN);
  if (auto *obj = OBJ(presenter_close_label)) lv_obj_set_style_text_color(obj, text, LV_PART_MAIN);
  if (auto *obj = OBJ(presenter_role)) lv_obj_set_style_text_color(obj, accent, LV_PART_MAIN);
  if (auto *obj = OBJ(presenter_tagline)) lv_obj_set_style_text_color(obj, muted, LV_PART_MAIN);
  if (auto *obj = OBJ(btn_presenter_prev)) {
    lv_obj_set_style_bg_color(obj, surface, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(btn_presenter_next)) {
    lv_obj_set_style_bg_color(obj, surface, LV_PART_MAIN);
    lv_obj_set_style_border_color(obj, rule, LV_PART_MAIN);
  }
  if (auto *obj = OBJ(presenter_prev_label)) lv_obj_set_style_text_color(obj, text, LV_PART_MAIN);
  if (auto *obj = OBJ(presenter_next_label)) lv_obj_set_style_text_color(obj, text, LV_PART_MAIN);
  if (auto *obj = OBJ(presenter_count_lbl)) lv_obj_set_style_text_color(obj, muted, LV_PART_MAIN);

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

  if (c->shown_logo_url().empty()) {
    lv_obj_add_flag(OBJ(station_logo), LV_OBJ_FLAG_HIDDEN);
  }
  if (c->shown_now_avatar_url().empty()) {
    lv_obj_add_flag(OBJ(now_avatar), LV_OBJ_FLAG_HIDDEN);
  }
  // One well for a solo host, two when the show has a co-host. The decoded
  // image un-hides the well itself; this is what puts it back when the show
  // changes to a single host.
  if (c->shown_now_avatar_2_url().empty()) {
    ui_hide_now_avatar_2();
  }

  const char *err = c->last_error().c_str();
  lv_label_set_text(OBJ(status_line), err);

  char runway[32];
  const int64_t remaining_sec = b.ends_in_sec > 0
                                    ? std::max<int64_t>(0, b.ends_in_sec - static_cast<int64_t>(c->state_age_sec()))
                                    : b.ends_in_sec;
  if (remaining_sec > 0) {
    int h = (int) (remaining_sec / 3600), m = (int) ((remaining_sec % 3600) / 60);
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
  lv_obj_t *row_avatars[5] = {OBJ(row_0_avatar), OBJ(row_1_avatar), OBJ(row_2_avatar), OBJ(row_3_avatar), OBJ(row_4_avatar)};
  lv_obj_t *row_avatars2[5] = {OBJ(row_0_avatar2), OBJ(row_1_avatar2), OBJ(row_2_avatar2), OBJ(row_3_avatar2), OBJ(row_4_avatar2)};

  const auto &slots = c->schedule_slots();
  if (!slots.empty()) {
    for (int i = 0; i < 5; i++) {
      if (i < (int) slots.size()) {
        const auto &slot = slots[i];
        std::string time_lbl = slot.from;
        if (!slot.to.empty()) time_lbl += " - " + slot.to;
        if (slot.live) {
          time_lbl = "LIVE · " + time_lbl;
        } else if (!slot.day.empty() && (slot.day_offset > 0 || slot.day != c->schedule_day_label())) {
          time_lbl += "\n" + slot.day;
        } else if (slot.day_offset > 0) {
          time_lbl += "\nTomorrow";
        }
        lv_label_set_text(row_times[i], time_lbl.c_str());
        lv_label_set_text(row_names[i], slot.name.empty() ? "Auto DJ" : slot.name.c_str());
        lv_label_set_text(row_hosts[i], slot.host.empty() ? "Station Rotation" : slot.host.c_str());
        if (slot.avatar_url.empty() && row_avatars[i] != nullptr) {
          lv_obj_add_flag(row_avatars[i], LV_OBJ_FLAG_HIDDEN);
        }
        const std::string second_avatar =
            slot.presenters.size() > 1 ? slot.presenters[1].avatar_url : std::string();
        if (second_avatar.empty() && row_avatars2[i] != nullptr) {
          lv_obj_add_flag(row_avatars2[i], LV_OBJ_FLAG_HIDDEN);
        }
      } else {
        lv_label_set_text(row_times[i], "—");
        lv_label_set_text(row_names[i], "");
        lv_label_set_text(row_hosts[i], "");
        if (row_avatars[i] != nullptr) {
          lv_obj_add_flag(row_avatars[i], LV_OBJ_FLAG_HIDDEN);
        }
        if (row_avatars2[i] != nullptr) {
          lv_obj_add_flag(row_avatars2[i], LV_OBJ_FLAG_HIDDEN);
        }
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

  if (lv_obj_t *btn_lbl = OBJ(lbl_clear_cache)) {
    lv_label_set_text(btn_lbl, "Clear Cache");
  }

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
  char up[64];
  if (secs > 86400) snprintf(up, sizeof(up), "%d days %d hours | touches: %u", (int) (secs / 86400), (int) ((secs % 86400) / 3600), (unsigned) s_touch_counter);
  else if (secs > 3600) snprintf(up, sizeof(up), "%d hours %d minutes | touches: %u", (int) (secs / 3600), (int) ((secs % 3600) / 60), (unsigned) s_touch_counter);
  else snprintf(up, sizeof(up), "%d minutes | touches: %u", (int) (secs / 60), (unsigned) s_touch_counter);
  lv_label_set_text(OBJ(val_up), up);
}

/**
 * The cache statistics line.
 *
 * Deliberately NOT part of settings_refresh(): that runs on every touch, and
 * this used to take cache_mutex_ twice there while the worker could hold it
 * across a full PSRAM decode — up to 200ms inside the press handler, which is
 * long enough for the release to arrive before LVGL has read the press and the
 * tap is lost. The counters are atomic now, and this is painted on a slow tick.
 */
void ui_refresh_cache_stats() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;
  if (lv_obj_t *stats = OBJ(lbl_cache_stats)) {
    char buf[48];
    snprintf(buf, sizeof(buf), "%d images (%d KB)", (int) c->avatar_cache_count(), (int) c->avatar_cache_kb());
    lv_label_set_text(stats, buf);
  }
}

// Is the install actually moving? Checking and Downloading are work the person
// can watch; Verifying, Installing and Rebooting are the points where the bar
// is already full but the screen has not restarted yet.
// "Install now" was pressed and the worker has not yet published a phase.
// Cleared by ui_paint_firmware_modal_() as soon as the snapshot moves, or after
// fifteen seconds if it never does — a card that waits forever is worse than
// the question it replaced.
static bool s_ota_request_pending = false;
static uint32_t s_ota_request_ms = 0;

static bool ota_state_in_progress(OtaUiState state) {
  switch (state) {
    case OtaUiState::Checking:
    case OtaUiState::Downloading:
    case OtaUiState::Verifying:
    case OtaUiState::Installing:
    case OtaUiState::Rebooting:
      return true;
    case OtaUiState::Idle:
    case OtaUiState::Available:
    case OtaUiState::Confirming:
    case OtaUiState::Failed:
      return false;
  }
  return false;
}

/**
 * Paint the dialog from the worker's snapshot.
 *
 * THREE SHAPES, ONE CARD. A question with two buttons; a progress bar with no
 * buttons, because an install in flight cannot be cancelled; and an answer with
 * one button. The shape is chosen from the same OtaView the row reads, so the
 * card and the row can never disagree about what phase the screen is in.
 *
 * Does nothing while the card is hidden: opening is an explicit act, and a
 * published release must not put a dialog on the glass by itself.
 */
// The last snapshot the card actually painted, so a one-second tick that has
// nothing new to say does not repaint it.
static uint32_t s_ota_card_key = 0;
static bool s_ota_card_painted = false;

// The install owns the backlight while it writes flash. The panel is scanned
// from PSRAM, and every flash operation suspends the external-memory cache, so
// the panel cannot be fed for the length of each write; on a lit screen that is
// a band of garbage every eight kilobytes. The install therefore stages the
// whole image in PSRAM first and only then asks for the screen to go dark.
//
// The request is applied from loopTask (see ui_apply_ota_screen_), because
// LightState is loopTask's; the worker polls ui_ota_screen_is_off() rather than
// touching the light from Core 0, and the screen stays dark through the
// restart. The light's ALWAYS_ON restore mode brings it back at boot.
static bool s_ota_screen_wanted_off = false;
static bool s_ota_screen_applied_off = false;

void ui_ota_screen_on(bool on) { s_ota_screen_wanted_off = !on; }

bool ui_ota_screen_is_off() { return s_ota_screen_applied_off; }

static uint32_t ota_card_key_(bool pending, uint8_t state, int progress, const std::string &message) {
  uint32_t h = 2166136261u;
  for (const char ch : message) {
    h ^= static_cast<uint8_t>(ch);
    h *= 16777619u;
  }
  h ^= (static_cast<uint32_t>(state) + (pending ? 0x100u : 0u)) * 16777619u;
  h ^= static_cast<uint32_t>(progress + 1) * 40503u;
  return h;
}

// A dimmed backdrop has to be re-blended with everything under it, so every
// repaint of the card becomes a full-screen alpha blend. While the OTA worker
// is erasing flash the external-memory cache is suspended in bursts; that blend
// then takes seconds instead of milliseconds and the five-second task watchdog
// aborts the chip (observed on the first download: loopTask died inside
// lv_draw_sw_blend_color_to_rgb565). Once work starts the backdrop therefore
// goes opaque, which makes a repaint a plain fill that survives the stall.
// The question keeps the dimmed look; nothing is writing flash while it is up.
static void ota_set_backdrop_opa_(lv_obj_t *modal, bool opaque) {
  lv_obj_set_style_bg_opa(modal, opaque ? LV_OPA_COVER : LV_OPA_80, LV_PART_MAIN);
}

static void ui_paint_firmware_modal_() {
  if (!ui_ready()) return;
  // While the install holds the screen dark nothing painted can be seen, and
  // every paint is LVGL work that would land between the flash writes the
  // darkness exists to hide.
  if (s_ota_screen_applied_off) return;
  auto *c = client();
  if (c == nullptr) return;
  lv_obj_t *modal = OBJ(ota_modal);
  if (modal == nullptr || lv_obj_has_flag(modal, LV_OBJ_FLAG_HIDDEN)) return;

  const OtaView view = c->ota_view();
  lv_obj_t *title = OBJ(ota_modal_title);
  lv_obj_t *message = OBJ(ota_modal_message);
  lv_obj_t *track = OBJ(ota_progress_track);
  lv_obj_t *fill = OBJ(ota_progress_fill);
  lv_obj_t *pct = OBJ(ota_progress_pct);
  lv_obj_t *yes = OBJ(btn_ota_yes);
  lv_obj_t *no = OBJ(btn_ota_no);
  lv_obj_t *yes_label = OBJ(ota_yes_label);
  lv_obj_t *no_label = OBJ(ota_no_label);

  // A request that was just enqueued is not yet an accepted install. Keep the
  // question hidden until the worker's snapshot moves, so a five-second tick
  // landing in that gap cannot put "Install now" back under a finger that has
  // already tapped it and enqueue a second request.
  if (s_ota_request_pending && view.state != OtaUiState::Available) {
    s_ota_request_pending = false;  // the worker has spoken: accepted, refused or finished
  }
  if (s_ota_request_pending && esphome::millis() - s_ota_request_ms > 15000) {
    s_ota_request_pending = false;  // the command never reached the worker
  }

  // Nothing new to say: leave the card alone. Every repaint of this card touches
  // the whole panel, and during an install that is exactly the work the memory
  // system cannot finish in time.
  const uint32_t key =
      ota_card_key_(s_ota_request_pending, static_cast<uint8_t>(view.state), view.progress, view.message);
  if (s_ota_card_painted && key == s_ota_card_key) return;
  s_ota_card_key = key;
  s_ota_card_painted = true;

  if (s_ota_request_pending) {
    ota_set_backdrop_opa_(modal, true);
    lv_label_set_text(title, "Update requested");
    lv_label_set_text(message, "Waiting for the station to accept the update.");
    if (yes != nullptr) lv_obj_add_flag(yes, LV_OBJ_FLAG_HIDDEN);
    if (no != nullptr) lv_obj_add_flag(no, LV_OBJ_FLAG_HIDDEN);
    if (track != nullptr) lv_obj_clear_flag(track, LV_OBJ_FLAG_HIDDEN);
    if (fill != nullptr) lv_obj_set_width(fill, 0);
    if (pct != nullptr) {
      lv_obj_clear_flag(pct, LV_OBJ_FLAG_HIDDEN);
      lv_label_set_text(pct, "0%");
    }
    return;
  }

  if (ota_state_in_progress(view.state)) {
    ota_set_backdrop_opa_(modal, true);
    lv_label_set_text(title, "Updating firmware");
    lv_label_set_text(message, view.message.empty() ? "Working..." : view.message.c_str());
    if (yes != nullptr) lv_obj_add_flag(yes, LV_OBJ_FLAG_HIDDEN);
    if (no != nullptr) lv_obj_add_flag(no, LV_OBJ_FLAG_HIDDEN);
    if (track != nullptr) lv_obj_clear_flag(track, LV_OBJ_FLAG_HIDDEN);
    if (pct != nullptr) {
      char buf[8];
      snprintf(buf, sizeof(buf), "%d%%", view.progress);
      lv_obj_clear_flag(pct, LV_OBJ_FLAG_HIDDEN);
      lv_label_set_text(pct, buf);
    }
    if (fill != nullptr) {
      const int width = (840 * view.progress) / 100;
      lv_obj_set_width(fill, width > 0 ? width : 0);
    }
    return;
  }

  // Not moving: the question, the failure, or the current version.
  ota_set_backdrop_opa_(modal, false);
  if (track != nullptr) lv_obj_add_flag(track, LV_OBJ_FLAG_HIDDEN);
  if (pct != nullptr) lv_obj_add_flag(pct, LV_OBJ_FLAG_HIDDEN);
  if (no != nullptr) lv_obj_clear_flag(no, LV_OBJ_FLAG_HIDDEN);
  if (no_label != nullptr) lv_label_set_text(no_label, view.state == OtaUiState::Available ? "Not now" : "Close");

  if (view.state == OtaUiState::Available) {
    const std::string heading = view.published_version.empty()
                                    ? std::string("Firmware update ready")
                                    : ("Firmware " + view.published_version + " is ready");
    lv_label_set_text(title, heading.c_str());
    lv_label_set_text(message,
                      "This screen will download the update, check it, install it, and restart. "
                      "It keeps working until the new version has started.");
    if (yes_label != nullptr) lv_label_set_text(yes_label, "Install now");
    if (yes != nullptr) lv_obj_clear_flag(yes, LV_OBJ_FLAG_HIDDEN);
    return;
  }

  if (view.state == OtaUiState::Failed) {
    lv_label_set_text(title, "Update failed");
    lv_label_set_text(message, view.message.empty()
                                   ? "The update did not finish. Try again, or close this and keep the current firmware."
                                   : view.message.c_str());
    // Retrying is only offered when there is still something published to
    // fetch; a refused request with no release behind it cannot be retried.
    if (yes_label != nullptr) lv_label_set_text(yes_label, "Try again");
    if (yes != nullptr) {
      if (view.published_version.empty()) {
        lv_obj_add_flag(yes, LV_OBJ_FLAG_HIDDEN);
      } else {
        lv_obj_clear_flag(yes, LV_OBJ_FLAG_HIDDEN);
      }
    }
    return;
  }

  // Idle or Confirming: an answer, not a question.
  lv_label_set_text(title, view.state == OtaUiState::Confirming ? "Update installed" : "Firmware up to date");
  lv_label_set_text(message, view.message.empty()
                                 ? "This screen is running the latest published firmware."
                                 : view.message.c_str());
  if (yes != nullptr) lv_obj_add_flag(yes, LV_OBJ_FLAG_HIDDEN);
}

/**
 * The Settings -> Firmware Update row.
 *
 * Painted from the worker's snapshot, never from an optimistic local guess. A
 * row that said "Installing" the moment the glass was touched would be lying
 * whenever the station refused the request — and the refusal is the one thing
 * the person standing at the screen needs to read.
 *
 * Slow tick for the same reason as the cache line: the sentence changes when
 * the worker says so, not when somebody touches the screen.
 */
void ui_refresh_firmware_update() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;
  lv_obj_t *state = OBJ(lbl_update_state);
  if (state == nullptr) return;

  const OtaView view = c->ota_view();
  bool active = false;
  switch (view.state) {
    case OtaUiState::Available:
    case OtaUiState::Checking:
    case OtaUiState::Downloading:
    case OtaUiState::Verifying:
    case OtaUiState::Installing:
    case OtaUiState::Rebooting:
    case OtaUiState::Confirming:
      active = true;
      break;
    case OtaUiState::Idle:
    case OtaUiState::Failed:
      break;
  }

  // The sentence behind the card is not visible, and painting it would
  // invalidate pixels under an opaque overlay: wasted work during an install,
  // where every redraw competes with the flash worker for the memory system.
  // Closing the card repaints the row on the next tick.
  lv_obj_t *modal = OBJ(ota_modal);
  if (modal == nullptr || lv_obj_has_flag(modal, LV_OBJ_FLAG_HIDDEN)) {
    lv_label_set_text(state, view.message.empty() ? "Up to date" : view.message.c_str());
    lv_obj_set_style_text_color(state, lv_color_hex(active ? INT(c_accent) : INT(c_muted)), LV_PART_MAIN);

    // The button appears only when a tap on it can do something. A permanently
    // visible "Update" on a screen that is already current is a button that
    // teaches people it does nothing.
    const bool retryable = view.state == OtaUiState::Failed && !view.published_version.empty();
    const bool offered = view.state == OtaUiState::Available || retryable;
    if (lv_obj_t *action = OBJ(btn_update)) {
      if (offered) {
        lv_obj_clear_flag(action, LV_OBJ_FLAG_HIDDEN);
      } else {
        lv_obj_add_flag(action, LV_OBJ_FLAG_HIDDEN);
      }
    }
    if (lv_obj_t *action_label = OBJ(lbl_update_action)) {
      lv_label_set_text(action_label, view.state == OtaUiState::Failed ? "Retry" : "Update");
    }
  }

  // The dialog is repainted from the same snapshot, on the same tick, so its
  // bar and the row's sentence can never tell different stories.
  ui_paint_firmware_modal_();
}

void ui_show_firmware_prompt() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;
  lv_obj_t *modal = OBJ(ota_modal);
  if (modal == nullptr) return;
  s_ota_card_painted = false;  // opening is always a fresh paint
  lv_obj_clear_flag(modal, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_foreground(modal);
  ui_paint_firmware_modal_();
  lv_obj_invalidate(modal);
}

void ui_hide_firmware_prompt() {
  if (!ui_ready()) return;
  lv_obj_t *modal = OBJ(ota_modal);
  if (modal == nullptr) return;
  s_ota_card_painted = false;
  lv_obj_add_flag(modal, LV_OBJ_FLAG_HIDDEN);
  lv_obj_invalidate(modal);
}

static void ui_apply_ota_screen_() {
  if (s_ota_screen_wanted_off == s_ota_screen_applied_off) return;
  if (g_backlight == nullptr) {
    // Nothing to drive: report what was asked so the worker is not left
    // polling a light that does not exist on this build.
    s_ota_screen_applied_off = s_ota_screen_wanted_off;
    return;
  }
  auto call = g_backlight->make_call();
  if (s_ota_screen_wanted_off) {
    call.set_state(false);
  } else {
    auto *c = client();
    call.set_state(true);
    call.set_brightness(c == nullptr ? 1.0f : (float) c->settings().brightness / 100.0f);
  }
  // Short enough to be finished before the first flash operation, long enough
  // to read as the install taking the screen rather than the screen failing.
  call.set_transition_length(300);
  call.perform();
  s_ota_screen_applied_off = s_ota_screen_wanted_off;
  ESP_LOGI(TAG, "OTA screen %s for the install.", s_ota_screen_applied_off ? "off" : "on");
}

void ui_tick_firmware_dialog() {
  // Applied before the early returns: the screen has to go dark even when the
  // dialog is no longer the thing being painted.
  ui_apply_ota_screen_();
  // Nothing painted now would be seen, and painting behind the darkness would
  // put LVGL work into the gaps between the flash writes it exists to hide.
  if (s_ota_screen_applied_off) return;
  if (!ui_ready()) return;
  lv_obj_t *modal = OBJ(ota_modal);
  if (modal == nullptr || lv_obj_has_flag(modal, LV_OBJ_FLAG_HIDDEN)) return;
  ui_paint_firmware_modal_();
}

void ui_confirm_firmware_update() {
  if (!ui_ready()) return;
  auto *c = client();
  if (c == nullptr) return;
  const OtaView view = c->ota_view();
  // Only a real question may be answered. A stale tap on a dialog that was
  // opened before the station withdrew the release must not turn into an
  // install request; the row will be repainted with what actually happened.
  if (view.state != OtaUiState::Available && view.state != OtaUiState::Failed) return;
  if (view.state == OtaUiState::Failed && view.published_version.empty()) return;

  // The enqueue is synchronous; the station's answer is not. The card says the
  // request was made and waits, and the worker's Checking or Failed snapshot
  // replaces it on the next tick. The buttons go now, so a second tap cannot
  // enqueue a second request.
  s_ota_request_pending = true;
  s_ota_request_ms = esphome::millis();
  c->request_firmware_update();
  ui_paint_firmware_modal_();
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
void bind_backlight(esphome::light::LightState *light) {
  g_backlight = light;
  ESP_LOGI(TAG, "Backlight bound (%p).", (void *) light);
}

void idle_apply(bool asleep) {
  // A firmware install owns the backlight while it applies the image. The
  // one-second keepalive must not light a screen that is dark because the panel
  // cannot be fed during flash writes.
  if (s_ota_screen_wanted_off) return;
  auto *c = client();
  if (c == nullptr || !ui_ready()) return;

  // WALL DISPLAY: screen is ALWAYS on. idle_apply() is called from idle_touch()
  // (wake) and idle_poll() (deadline passed). We never actually turn off the
  // backlight - a wall screen should always be visible.
  BOOL(screen_asleep) = asleep;

  if (g_backlight == nullptr) return;

  // Only re-apply if brightness actually changed — avoids restarting the 800ms
  // transition on every poll/tick, which causes visible flicker.
  float brightness = c == nullptr ? 1.0f : (float) c->settings().brightness / 100.0f;
  static float last_applied = -1.0f;
  if (brightness == last_applied) return;
  last_applied = brightness;

  ESP_LOGI(TAG, "idle_apply(asleep=%d): setting backlight to %d%% (800ms transition).", (int) asleep, (int) (brightness * 100.0f));

  auto call = g_backlight->make_call();
  call.set_state(true);
  call.set_brightness(brightness);
  call.set_transition_length(800);
  call.perform();
}

void idle_touch() {
  s_touch_counter++;
  if (ui_ready() && OBJ(val_up) != nullptr) {
    settings_refresh();
  }
  // Any touch wakes, and restarts the full timer. A track change, a show change
  // or a heartbeat deliberately do NOT: a screen nobody is touching should stay
  // as it is rather than lighting itself up in an empty room.
  //
  // esphome::millis(), NOT station_now_ms(). It used to be the server's clock,
  // which made the idle deadline depend on the server answering — a screen that
  // could not reach the station would never time out — and it jumps when the
  // server's does, which would blank the screen early or never.
  //
  // We do NOT call idle_apply() here because on_touch fires before on_click on
  // brightness segments. Calling idle_apply() would briefly flash the previous
  // brightness before set_brightness_to() updates it. The 1-second keepalive
  // interval maintains the backlight at the correct brightness within a second.
  auto *c = client();
  const uint32_t minutes = c == nullptr || c->settings().idle_min == 0 ? 30u : (uint32_t) c->settings().idle_min;
  const std::string mode = c == nullptr ? std::string("stay") : c->settings().idle_mode;
  float brightness = c == nullptr ? 1.0f : (float) c->settings().brightness / 100.0f;
  ESP_LOGI(TAG, "Idle touch: wake (backlight %d%%), deadline %u minutes, mode=%s", (int) (brightness * 100.0f), (unsigned) minutes, mode.c_str());
  U32(idle_deadline_ms) = (uint32_t) esphome::millis() + minutes * 60000u;
}

/**
 * The idle tick. Asks one question and does whichever phase of the idle sequence
 * has come due. Called from the YAML interval every five seconds.
 *
 * WALL DISPLAY: the screen never dims or blanks. Every poll re-asserts the
 * backlight at 100% as a safety net — if anything outside this file drives the
 * backlight off, the next poll brings it back within five seconds.
 *
 * THERE IS NO TIMER HERE, and that is deliberate. ESPHome 2026.7's Application
 * has no timeout scheduling at all, so a deferred call has to be a deadline
 * checked by the next tick. And a self-rescheduling timer would have to be
 * cancelled and rebuilt on every wake, which is the shape of bug that outlives
 * the firmware. A poll cannot leave a timer behind.
 */
void idle_poll() {
  // Safety net: re-assert full brightness on every poll so the backlight can
  // never stay off for more than one poll interval.
  auto *c = client();
  if (c == nullptr || !ui_ready()) return;
  if (g_backlight == nullptr) return;
  idle_apply(false);
}

void ui_apply_logo(esphome::image::Image *img) {
  if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  lv_obj_t *obj = OBJ(station_logo);
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
}

void ui_apply_now_avatar(esphome::image::Image *img) {
  if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  lv_obj_t *obj = OBJ(now_avatar);
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
}

void ui_set_now_avatar_dual(bool dual) {
  if (!ui_ready()) return;
  // The co-host well takes the gap between the on-air portrait and the byline,
  // so the text column and the live lamp move across with it. Both layouts are
  // stated here rather than by calling lv_obj_set_x() from two places.
  const int text_x = dual ? 298 : 198;
  const int text_w = dual ? 358 : 458;
  if (auto *obj = OBJ(byline_presenter)) {
    lv_obj_set_x(obj, text_x);
    lv_obj_set_width(obj, text_w);
  }
  if (auto *obj = OBJ(byline_show)) {
    lv_obj_set_x(obj, text_x);
    lv_obj_set_width(obj, text_w);
  }
  if (auto *obj = OBJ(byline_runway)) {
    lv_obj_set_x(obj, text_x);
    lv_obj_set_width(obj, text_w);
  }
  if (auto *lamp = OBJ(live_lamp)) {
    lv_obj_set_x(lamp, dual ? 272 : 172);
  }
}

void ui_apply_now_avatar_2(esphome::image::Image *img) {
  if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  if (auto *well = OBJ(now_avatar_2_well)) {
    lv_obj_clear_flag(well, LV_OBJ_FLAG_HIDDEN);
  }
  lv_obj_t *obj = OBJ(now_avatar_2);
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
  ui_set_now_avatar_dual(true);
}

void ui_hide_now_avatar_2() {
  if (!ui_ready()) return;
  if (auto *well = OBJ(now_avatar_2_well)) {
    lv_obj_add_flag(well, LV_OBJ_FLAG_HIDDEN);
  }
  ui_set_now_avatar_dual(false);
}

void ui_apply_row_avatar(int slot, esphome::image::Image *img) {
  if (img == nullptr || slot < 0 || slot >= 5 || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  char name[32];
  snprintf(name, sizeof(name), "row_%d_avatar", slot);
  lv_obj_t *obj = static_cast<lv_obj_t *>(lookup(name));
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
}

void ui_apply_row_avatar_2(int slot, esphome::image::Image *img) {
  if (img == nullptr || slot < 0 || slot >= 5 || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  char name[32];
  snprintf(name, sizeof(name), "row_%d_avatar2", slot);
  lv_obj_t *obj = static_cast<lv_obj_t *>(lookup(name));
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
}

void ui_apply_cover_art(esphome::image::Image *img, int slot) {
  if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  // Bindings keep their boot identities while YAML swaps the incoming/outgoing roles.
  lv_obj_t *obj = slot == 1 ? OBJ(art_out) : OBJ(art_in);
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
  }
}

void presenter_modal_show(const char *name, const char *role, const char *tagline, esphome::image::Image *placeholder_img, size_t current_idx, size_t total_count) {
  if (!ui_ready() || OBJ(presenter_modal) == nullptr) return;

  if (auto *lbl = OBJ(presenter_name)) {
    lv_label_set_text(lbl, (name != nullptr && name[0] != '\0') ? name : "Presenter");
  }
  if (auto *lbl = OBJ(presenter_role)) {
    lv_label_set_text(lbl, (role != nullptr && role[0] != '\0') ? role : "Host");
  }
  if (auto *lbl = OBJ(presenter_tagline)) {
    if (tagline != nullptr && tagline[0] != '\0' && strcmp(tagline, "null") != 0) {
      lv_label_set_text(lbl, tagline);
      lv_obj_set_style_text_color(lbl, lv_color_hex(0xDCE8F5), LV_PART_MAIN);
    } else {
      lv_label_set_text(lbl, "No bio provided for this presenter.");
      lv_obj_set_style_text_color(lbl, lv_color_hex(0x6A8BA8), LV_PART_MAIN);
    }
  }

  if (auto *avatar = OBJ(presenter_avatar)) {
    lv_image_set_inner_align(avatar, LV_IMAGE_ALIGN_COVER);
    lv_image_set_antialias(avatar, true);
    if (placeholder_img != nullptr && placeholder_img->get_data_start() != nullptr &&
        placeholder_img->get_width() > 0 && placeholder_img->get_height() > 0) {
      ::lv_image_set_src(avatar, placeholder_img->get_lv_image_dsc());
      lv_obj_clear_flag(avatar, LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_add_flag(avatar, LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (auto *nav = OBJ(presenter_nav_panel)) {
    if (total_count > 1) {
      lv_obj_clear_flag(nav, LV_OBJ_FLAG_HIDDEN);
      if (auto *cnt = OBJ(presenter_count_lbl)) {
        char buf[48];
        snprintf(buf, sizeof(buf), "Presenter %u of %u", static_cast<unsigned>(current_idx + 1), static_cast<unsigned>(total_count));
        lv_label_set_text(cnt, buf);
      }
    } else {
      lv_obj_add_flag(nav, LV_OBJ_FLAG_HIDDEN);
    }
  }

  auto *modal = OBJ(presenter_modal);
  lv_obj_clear_flag(modal, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_foreground(modal);
  lv_obj_invalidate(modal);
}

void presenter_modal_dismiss() {
  if (!ui_ready() || OBJ(presenter_modal) == nullptr) return;
  auto *modal = OBJ(presenter_modal);
  lv_obj_add_flag(modal, LV_OBJ_FLAG_HIDDEN);
  lv_obj_invalidate(modal);
}

void ui_apply_modal_avatar(esphome::image::Image *img) {
  if (img == nullptr || img->get_data_start() == nullptr || img->get_width() <= 0 || img->get_height() <= 0) return;
  lv_obj_t *obj = OBJ(presenter_avatar);
  if (obj != nullptr) {
    ::lv_image_set_src(obj, img->get_lv_image_dsc());
    lv_image_set_inner_align(obj, LV_IMAGE_ALIGN_COVER);
    lv_image_set_antialias(obj, true);
    lv_obj_clear_flag(obj, LV_OBJ_FLAG_HIDDEN);
  }
}

}  // namespace subwave_display