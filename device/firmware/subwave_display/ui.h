#pragma once

#include <cstdint>

// For lv_obj_t, in bind_object(). ESPHome's lvgl_esphome.h is the only
// header that gets this right: it establishes the LVGL build configuration
// before the type is declared.
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
void chrome_refresh();

/** Blank the screen and show the "tap to wake" line, or the reverse. */
void idle_apply(bool asleep);
void idle_touch();

/** Server time in ms, taken from the station rather than from a local clock. */
int64_t station_now_ms();

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

}  // namespace subwave_display