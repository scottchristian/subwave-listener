#pragma once

// The inactivity policy, without ESPHome, LVGL or a clock.
//
// WHY IT IS A HEADER OF ITS OWN. The interesting part of idle behaviour is not
// the backlight call — it is "given what the settings say and how long it has
// been since somebody touched the glass, which phase should be in effect now".
// That question can be answered by an ordinary function, so it is, and both the
// firmware and a native test compile the same code. A test that re-implements
// the rules in another language proves the test, not the screen.
//
// TIME IS PASSED IN, ALWAYS. There is no millis() here, so the test can drive a
// whole night in microseconds, and the firmware can keep using the one
// monotonic, uint32_t-wrapping counter the rest of the device already uses.
// elapsed_since() is the only subtraction, and it is the wrapping-safe form:
// unsigned arithmetic makes a single wrap invisible as long as the interval is
// shorter than 2^31 ms (24.8 days), which the 240-minute maximum is.

#include <cstdint>
#include <cstring>

namespace subwave_idle {

enum class Phase : uint8_t {
  Awake = 0,
  Dimmed = 1,
  Off = 2,
};

/** The settings that decide the phase, already reduced to what matters. */
struct Policy {
  bool stay{false};      // mode "stay": never dim, never turn off
  bool off_only{false};  // mode "off": go straight to the backlight off
  uint32_t idle_ms{15u * 60000u};
  uint32_t off_ms{0};  // additional delay after dimming; 0 = never
};

/** Minutes as milliseconds, bounded to the values the contract allows. */
inline uint32_t minutes_to_ms(int minutes, int fallback_minutes) {
  int m = minutes;
  if (m <= 0) m = fallback_minutes;
  if (m < 1) m = 1;
  if (m > 240) m = 240;
  return static_cast<uint32_t>(m) * 60000u;
}

inline Policy policy_for(const char *mode, int idle_min, int idle_off_min) {
  Policy p;
  p.stay = mode != nullptr && std::strcmp(mode, "stay") == 0;
  p.off_only = mode != nullptr && std::strcmp(mode, "off") == 0;
  p.idle_ms = minutes_to_ms(idle_min, 30);
  // 0 is a real value and means "never". Only a positive value schedules the
  // second step, and it is an ADDITIONAL delay, not a second absolute deadline.
  p.off_ms = idle_off_min > 0 ? minutes_to_ms(idle_off_min, 0) : 0;
  return p;
}

/** Wrapping-safe elapsed time. The only place time is subtracted. */
inline uint32_t elapsed_since(uint32_t now_ms, uint32_t then_ms) { return now_ms - then_ms; }

/**
 * Which phase should be showing now.
 *
 * THE INPUTS ARE THE STATE MACHINE. `phase` is what is on the glass, `elapsed`
 * is time since the last touch, and `since_dim` is time since the dim actually
 * applied. Nothing here reads or writes the backlight.
 *
 * A SETTINGS SYNC MUST NOT WAKE THE ROOM. If the mode becomes "stay" while the
 * screen is dimmed or off, this returns the phase unchanged: the screen stays as
 * it is until somebody touches it. Waking on a server poll would light an empty
 * hallway at 3am because an operator edited a setting.
 *
 * A HELD TOUCH PINS THE PHASE. Neither dimming nor turning off happens under a
 * finger that is still on the glass, even if the deadline passed while it was
 * held. The release re-arms the full period separately.
 */
inline Phase next_phase(Phase phase, bool touch_held, uint32_t elapsed_ms, uint32_t since_dim_ms,
                        const Policy &p) {
  if (touch_held) return phase;
  if (phase == Phase::Off) return Phase::Off;
  if (p.stay) return phase;
  if (phase == Phase::Awake) {
    if (elapsed_ms < p.idle_ms) return Phase::Awake;
    return p.off_only ? Phase::Off : Phase::Dimmed;
  }
  // Dimmed: the second delay is measured from the moment dimming applied, so a
  // changed timeout does not make an already-dimmed screen jump.
  if (p.off_only) return Phase::Off;
  if (p.off_ms == 0) return Phase::Dimmed;
  return since_dim_ms < p.off_ms ? Phase::Dimmed : Phase::Off;
}

inline int clamp_percent(int value) {
  if (value < 1) return 1;
  if (value > 100) return 100;
  return value;
}

/**
 * The absolute level dimming goes to.
 *
 * NEVER BRIGHTER THAN THE SCREEN ALREADY IS. A dim setting of 80 on a screen
 * configured at 30 is a request to raise the light, which is the opposite of
 * what the idle timeout is for; the lower of the two wins.
 */
inline int dim_percent(int normal_percent, int dim_setting_percent) {
  const int normal = clamp_percent(normal_percent);
  const int dim = clamp_percent(dim_setting_percent);
  return dim < normal ? dim : normal;
}

}  // namespace subwave_idle
