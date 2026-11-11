#pragma once

#include <cstdint>

// For lv_obj_t, in bind_object(). ESPHome's lvgl_esphome.h is the only
// header that gets this right: it establishes the LVGL build configuration
// before the type is declared.
#include "esphome/components/light/light_state.h"
#include "esphome/components/lvgl/lvgl_esphome.h"

namespace subwave_display {

/**
 * Painting, from C++ rather than from fifty lambdas.
 *
 * Everything here exists to keep one value in one place. A colour is chosen by
 * apply_theme() in theme.yaml, lands in the `c_*` globals, and is read from there
 * by these functions — so a window can never end up with a palette that was
 * never meant to exist, and a theme change reaches all three windows without
 * each needing its own copy of the rules.
 */
void theme_paint_all();
void now_refresh();
void shows_refresh();
void settings_refresh();
void ui_refresh_cache_stats();
/**
 * Paint the Settings -> Firmware Update row.
 *
 * On the slow tick rather than on every touch, for the same reason the cache
 * statistics line is: the row's sentence changes when the worker says so, not
 * when somebody touches the glass, and the install must not be able to repaint
 * the screen from the Core 0 side.
 */
void ui_refresh_firmware_update();

/**
 * The firmware update dialog.
 *
 * ui_show_firmware_prompt() opens it with the answer to "install this?" and
 * ui_hide_firmware_prompt() closes it. ui_confirm_firmware_update() is the
 * only code path that enqueues an install; it is reached from the dialog's
 * "Install now" button and nowhere else. The dialog repaints itself from the
 * worker's snapshot, so the progress bar can only show work that happened.
 */
void ui_show_firmware_prompt();
void ui_hide_firmware_prompt();
void ui_confirm_firmware_update();
/**
 * Repaint the dialog only while it is open, on the one-second tick.
 *
 * The row stays on the five-second tick; a progress bar that moved in five
 * second steps would look stuck during a sixty-second download. The check is
 * one hidden-flag read when nothing is showing, and the row is untouched.
 */
void ui_tick_firmware_dialog();

/**
 * The backlight, handed to the install for the length of one flash write.
 *
 * ui_ota_screen_on(false) asks for the screen to go dark and
 * ui_ota_screen_is_off() reports whether it has. The request is applied from
 * loopTask — LightState belongs to it — and the worker polls rather than
 * writing the light from Core 0. The screen stays dark until an install failure
 * asks for it back; a successful install restarts the chip with it dark and the
 * light's ALWAYS_ON restore mode brings it up again.
 *
 * This exists because the panel is scanned from PSRAM and every flash operation
 * suspends the external-memory cache, so the panel cannot be fed during a
 * write. There is no frame to show; a dark screen is the honest answer.
 */
void ui_ota_screen_on(bool on);
bool ui_ota_screen_is_off();

void presenter_modal_show(const char *name, const char *role, const char *tagline, esphome::image::Image *placeholder_img = nullptr, size_t current_idx = 0, size_t total_count = 1);
void presenter_modal_dismiss();

/** Apply decoded images to LVGL widgets safely on loopTask */
void ui_apply_logo(esphome::image::Image *img);
void ui_apply_now_avatar(esphome::image::Image *img);
/**
 * The co-host's portrait beside the on-air one.
 *
 * A show can be hosted by more than one person; the screen shows a face per
 * host rather than picking one. Painting the second face also moves the byline
 * text across, which is why the layout lives in ui_set_now_avatar_dual().
 */
void ui_apply_now_avatar_2(esphome::image::Image *img);
void ui_hide_now_avatar_2();
void ui_set_now_avatar_dual(bool dual);
void ui_apply_row_avatar(int slot, esphome::image::Image *img);
/** The second presenter's face on a schedule row. */
void ui_apply_row_avatar_2(int slot, esphome::image::Image *img);
void ui_apply_cover_art(esphome::image::Image *img, int slot);
void ui_apply_modal_avatar(esphome::image::Image *img);

// ---------------------------------------------------------------------------
// The inactivity controller.
//
// ONE STATE MACHINE, THREE PHASES, ONE OWNER OF THE BACKLIGHT. Awake shows the
// configured (theme-adjusted) brightness; Dimmed shows the lower of that and
// the dim setting; Off turns the backlight off. Touch wakes, and every touch
// restarts the full period.
//
// WHY A POLL RATHER THAN TIMERS. ESPHome 2026.7's Application has no timeout
// scheduling, and a self-rescheduling timer would have to be torn down and
// rebuilt on every touch — the shape of bug that outlives the firmware. One
// one-second check of a monotonic timestamp cannot leak a timer, and the wake
// path does not wait for it: a touch applies the light immediately.
//
// THE INSTALL OWNS THE LIGHT WHILE IT WRITES FLASH. ui_ota_screen_on(false) is
// checked before anything here touches the backlight, so polling and touching
// can never relight a screen that is dark because the panel cannot be fed.
// ---------------------------------------------------------------------------

/**
 * Start the controller. Called ONCE, after every widget is bound.
 *
 * Until this runs, no idle function touches either the binding table or the
 * light; the boot lambda's ordering is what keeps a store to an unbound
 * `screen_asleep` from being a reset loop.
 */
void idle_init();

/** Touch down. Wakes immediately; counts as activity. */
void idle_touch();
/** Touch moved while held. Counts as activity, but does not repaint settings. */
void idle_touch_move();
/** Touch released. Clears the hold and consumes a wake-only gesture. */
void idle_release();

/**
 * The one-second policy check. Applies the phase that is due, and reconciles a
 * changed brightness or dim setting without changing the phase.
 */
void idle_poll();

/**
 * A manual brightness change from the Settings screen.
 *
 * Applies it in the current phase and updates the controller's cached target,
 * so the next poll does not restart the same fade a second later.
 */
void idle_set_manual_brightness(int percent);

/** True while nothing should repaint artwork effects (screen off or installing). */
bool idle_effects_suspended();

// ---------------------------------------------------------------------------
// When Idle, the settings dialog.
// ---------------------------------------------------------------------------
void ui_show_idle_dialog();
void ui_hide_idle_dialog();
/** Repaint the dialog from the station's settings; no-op while it is closed. */
void ui_refresh_idle_dialog();

/** Server time in ms, taken from the station rather than from a local clock. */
int64_t station_now_ms();

/**
 * Paint the settings screen's clock.
 *
 * On its own one-second interval rather than the state poll or the idle tick.
 * Both of those are minutes-scale, and a clock fed from either is visibly
 * stepping and wrong to within the interval most of the time.
 */
void clock_refresh();

// ---------------------------------------------------------------------------
// The bindings.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A WORKAROUND.
//
// ESPHome emits every LVGL widget id, every `globals:` entry and every component
// pointer into its generated main.cpp as:
//
//     static globals::GlobalsComponent<int> *const c_bg = ...;
//     static lv_obj_t *const id_live_lamp = ...;
//     static subwave_display::SubwaveDisplay *const display_client = ...;
//
// `static` is internal linkage. NO other translation unit can ever name those
// symbols, so the obvious approach — `extern int c_bg;` in our own .cpp —
// compiles cleanly and then fails at link time with a page of undefined
// references. There is no header to include and none can be generated.
//
// So the pointers are HANDED OVER. One YAML lambda at boot calls the bind_*
// functions below with the objects, this file resolves them by name, and the
// painting code reads them through the OBJ()/INT()/BOOL() accessors.
//
// BY NAME RATHER THAN BY POSITION, and deliberately: a positional table would
// still compile if the YAML list and the header drifted apart, and would then
// paint one widget's text into another's label with nothing in the log. A
// missing name is caught by bindings_complete() and reported at boot.
// ---------------------------------------------------------------------------

/** Register an LVGL widget. The name is the YAML id WITHOUT the `id_` prefix. */
void bind_object(const char *name, lv_obj_t *obj);

/**
 * Register the backlight.
 *
 * Separate from bind_object because it is not a widget — it is a light
 * component, and the idle controller needs to drive it. `id(backlight)` is a
 * helper that only exists inside a YAML lambda, so from this translation unit
 * the object has to be handed over the same way every other one is.
 *
 * WHY THE BACKLIGHT AT ALL: dimming by showing a label over a still-lit screen
 * is not a screen going off. On a wall, in a dark room, at two metres, the
 * difference is the entire feature.
 */
void bind_backlight(esphome::light::LightState *light);
/** Register an `int` global — the palette, the window index, the queue depth. */
void bind_int(const char *name, int *value);
void bind_bool(const char *name, bool *value);
void bind_uint32(const char *name, uint32_t *value);
/** The one component this file talks to. */
void bind_client(class SubwaveDisplay *client);

/**
 * Report anything the boot lambda failed to bind.
 *
 * Called once after binding. A screen that is missing a widget would otherwise
 * paint into a null pointer or quietly do nothing, and the only symptom would be
 * that one label never changes — on a wall, weeks later.
 */
void bindings_report_missing();

/**
 * Announce that every widget has been handed over.
 *
 * Until this is called, every lookup returns null and every painter is a crash.
 * YAML calls it once, immediately after the last bind_* call.
 */
void ui_mark_ready();

/** Whether ui_mark_ready() has been called. Checked at the top of every painter. */
bool ui_ready();

}  // namespace subwave_display