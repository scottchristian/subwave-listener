#pragma once

#include "esphome/core/component.h"
#include "esphome/core/helpers.h"
#include "esphome/components/lvgl/lvgl_esphome.h"
#include <string>
#include <vector>

namespace subwave_display {

/**
 * A QR code for one string, drawn into an LVGL canvas.
 *
 * WHY THIS IS SMALL AND WHY IT IS HERE. The reference project for this panel has
 * no QR code anywhere in its tree, so this looked like work nobody had done. It
 * is not: ESPHome ships a `qr_code` component and an LVGL `qrcode` widget, both
 * built on nayuki's generator, and this wraps the widget rather than
 * reimplementing an encoder.
 *
 * Encoding exactly ONE symbol — the setup address — is what keeps it trivial. No
 * version selection, no error-recovery budget to tune, no mask search worth
 * arguing about: the address is a short string that always fits comfortably, and
 * the failure mode is a code that refuses to render rather than a screen that
 * boots slowly.
 *
 * A QUIET ZONE IS NOT OPTIONAL. LVGL's widget needs room around the symbol, and
 * a size that appears to fit without one will fail to generate. The widget is
 * therefore given padding rather than being sized exactly.
 *
 * COLOURS ARE OURS, not black and white: light_color and dark_color are set from
 * the same paper and ink tokens as everything else, so the code is part of the
 * design rather than a sticker on it.
 */
class QrSetup : public esphome::Component {
 public:
  void set_text(const std::string &text) { this->text_ = text; }
  void set_parent(lv_obj_t *parent) { this->parent_ = parent; }
  /** Set from the day palette's paper and ink. */
  void set_light(uint32_t c) { this->light_ = c; }
  void set_dark(uint32_t c) { this->dark_ = c; }

  void setup() override;
  void dump_config() override;

 protected:
  std::string text_{"http://192.168.4.1"};
  lv_obj_t *parent_{nullptr};
  uint32_t light_{0xE8EDF3};
  uint32_t dark_{0x0B1A2B};
};

/**
 * The setup page the device serves on its own access point.
 *
 * SERVED FROM FLASH, WHICH MEANS ONE CONSTRAINT SHAPES EVERY DECISION IN IT:
 * there is no internet, so no CDN, no webfont, no external image and no fetch of
 * any kind. The page is a single inline document — its HTML, CSS and behaviour
 * are a gzip'd string literal in PROGMEM rather than three files that would each
 * cost a request the phone cannot make.
 *
 * THE PAGE IS PAPER; THE PRODUCT IS GLASS. The screen is dark and cool because a
 * panel on a wall is a lit object in a room. The wizard is warm and light because
 * a setup flow is a document, and the inversion is what tells somebody standing
 * there that they are configuring something rather than already using it.
 *
 * THREE STEPS, THREE FAILURES, THREE DIFFERENT FIXES. The screen shows the same
 * three steps the page does, because a person carrying a panel cannot read a
 * phone and look at it at the same time. "Joined the WiFi" and "reached the
 * station" are different failures with different fixes and the page says which.
 */
class SetupPortal : public esphome::Component {
 public:
  void setup() override;
  void dump_config() override;

  /** The page, exactly as it will be served. Gzipped once, held in flash. */
  static std::string page_html();

  void set_ap_ssid(const std::string &s) { this->ap_ssid_ = s; }
  std::string ap_ssid() const { return this->ap_ssid_; }

 protected:
  std::string ap_ssid_{"SUBWAVE-SCREEN"};
};

}  // namespace subwave_display