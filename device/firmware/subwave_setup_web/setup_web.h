#pragma once

// NO `#ifdef USE_SUBWAVE_SETUP_WEB` GUARD.
//
// ESPHome generates `USE_<COMPONENT>` for CORE components only. An external
// component gets no such define, so a guard on one compiles the header down to
// nothing and main.cpp then fails with "'subwave_setup_web' has not been
// declared" — pointing at main.cpp, at the component id, and at nothing wrong
// with either. subwave_display's headers carry no guard for the same reason.
#include <functional>
#include <string>

#include "esphome/components/wifi/wifi_component.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"

// `AsyncWebHandler` and `AsyncWebServerRequest` are reachable unqualified only
// because web_server_base.h ends with
//   `using namespace esphome::web_server_idf;`
// ESPHome's own components (captive_portal, web_server) rely on exactly that,
// so this header does too rather than re-deriving the namespace by hand.
#include "esphome/components/web_server_base/web_server_base.h"

namespace esphome::subwave_setup_web {

/// The setup wizard a phone sees at http://192.168.4.1 while the screen is
/// unclaimed.
///
/// This exists because ESPHome's captive portal cannot be used: its handler is
/// `canHandle() { return this->active_ && method == HTTP_GET; }` — it claims
/// EVERY GET on the device — and the page it serves is ESPHome's, not this
/// station's. So `captive_portal:` is absent from the build and this handler
/// takes the routes instead.
///
/// It claims only the routes below. Everything else is deliberately left to
/// `web_server` so the dashboard, the REST API and `/update` (OTA) keep working.
class SetupWebHandler : public AsyncWebHandler {
 public:
  void set_station_name(const std::string &name) { this->station_name_ = name; }
  void set_ap_ssid(const std::string &ssid) { this->ap_ssid_ = ssid; }

  bool canHandle(AsyncWebServerRequest *request) const override;
  void handleRequest(AsyncWebServerRequest *request) override;

 protected:
  std::string station_name_{"SUB/WAVE"};
  std::string ap_ssid_{"SUBWAVE-SCREEN"};

  void send_wizard_(AsyncWebServerRequest *request);
  void send_scan_(AsyncWebServerRequest *request);
  void save_(AsyncWebServerRequest *request);
};

/// Registers the handler early enough to win.
///
/// WHY THE PRIORITY MATTERS. `WebServerBase::init()` walks `handlers_` in order
/// and adds each to the AsyncWebServer, and AsyncWebServer dispatches to the
/// FIRST handler whose `canHandle()` returns true. So a handler is only in front
/// of ESPHome's own if it is already in `handlers_` when `init()` runs — which
/// means it must be added before `web_server`'s own `setup()` calls `init()`.
///
/// `WebServer::get_setup_priority()` is `setup_priority::WIFI - 1.0f` (249).
/// ESPHome sorts components by DESCENDING priority — the log proves it: i2c
/// (BUS, 1000) sets up first and wifi (WIFI, 250) sets up later. So "before
/// web_server" means a LARGER number. `WIFI + 10` is 260: unambiguously ahead of
/// 249, and still late enough that `web_server_base` exists.
// ---------------------------------------------------------------------------
// The scan listener.
//
// WHY A LISTENER AND NOT A POLL. Both the on-screen list and the wizard's
// /scan route read `wifi->get_scan_result()`, which is only correct AFTER a
// scan has finished. Nothing else says when that is. A fixed `delay: 10s` is a
// guess that is wrong in both directions — too long when the radio answers in
// two seconds, and, worse, too SHORT on a busy band, which reads as "no
// networks found" when in fact the scan had not come back yet. An empty list
// that means "not finished" and an empty list that means "nothing there" are
// indistinguishable on the glass, so this component keeps a latch the two can
// be told apart by.
//
// The latch is set from on_wifi_scan_results(), which ESPHome calls from the
// scan-done path — the same moment `scan_result_` becomes valid.
// ---------------------------------------------------------------------------
class ScanResultsListener : public wifi::WiFiScanResultsListener {
 public:
  void on_wifi_scan_results(const wifi::wifi_scan_vector_t<wifi::WiFiScanResult> &results) override;

  /// True once at least one scan has completed. Until then a zero-length
  /// result set means "not finished", not "nothing found".
  bool scan_completed() const { return this->scan_completed_; }
  uint32_t completed_count() const { return this->completed_count_; }

  /// Fired after every completion, including the first.
  void set_callback(std::function<void()> cb) { this->callback_ = std::move(cb); }

 protected:
  bool scan_completed_{false};
  uint32_t completed_count_{0};
  std::function<void()> callback_{nullptr};
};

class SetupWebComponent : public Component, public ScanResultsListener {
 public:
  void set_station_name(const std::string &name) { this->station_name_ = name; }
  void set_ap_ssid(const std::string &ssid) { this->ap_ssid_ = ssid; }

  void setup() override;
  void dump_config() override;
  void loop() override;

  float get_setup_priority() const override { return setup_priority::WIFI + 10.0f; }

  /// Whether a scan has landed. Exposed to YAML so the setup screen can say
  /// "still scanning" instead of an empty list that looks like a dead radio.
  bool scan_completed() const { return this->scan_completed_; }

  /// Ask the radio for a fresh scan, stopping whatever is already running first.
  ///
  /// This exists because `WiFiComponent::start_scanning()` does not stop first,
  /// and this radio is left mid-scan by the scan ESPHome runs during wifi setup.
  /// While a scan is in progress, `esp_wifi_scan_start` — and, misleadingly,
  /// `esp_wifi_scan_stop` too — return ESP_ERR_WIFI_STATE, so every later scan
  /// is refused and the network list stays empty forever. See the .cpp for the
  /// full account; the one-line version is "stop the stuck scan, then start".
  ///
  /// Not a lambda: `esp_wifi_scan_stop` lives behind the IDF's esp_wifi.h, which
  /// main.cpp does not include.
  void request_scan();

  /// Report what the radio itself holds, independent of ESPHome's bookkeeping.
  ///
  /// `esp_wifi_scan_get_ap_num()` is the only way to ask the RADIO, rather than
  /// asking what ESPHome has been told. That distinction is the whole point:
  /// zero results in `get_scan_result()` means one of three quite different
  /// things — the scan never started, the scan started and heard nothing, or the
  /// scan heard plenty and the completion event never reached ESPHome — and only
  /// the radio can tell them apart.
  ///
  /// A lambda in YAML cannot do this: `esp_wifi_scan_get_ap_num` is declared in
  /// the IDF's esp_wifi.h, which main.cpp does not include, and a lambda cannot
  /// `#include` anything because it is inside a function body. So it lives here,
  /// in a translation unit that already includes the wifi headers.
  void log_radio_state();

  /// Called on every scan completion, after this component has logged it.
  ///
  /// This is how the on-screen list gets filled at the right moment. A YAML
  /// script cannot subscribe to WiFi scan results — the listener interface is
  /// C++ only — so YAML hands over a callback in `to_code` and this fires it.
  void set_on_scan_callback(std::function<void()> cb) { this->set_callback(std::move(cb)); }

  /// Invoked from `to_code` so the YAML side can supply the screen's script.
  ///
  /// A YAML script cannot implement a C++ listener interface, so this is the
  /// seam: `to_code` wraps the named script in a lambda and the component calls
  /// it at the moment a scan lands.
  void set_on_scan_script(std::function<void()> fn) { this->on_scan_setup_ = std::move(fn); }

 protected:
  SetupWebHandler *handler_{nullptr};
  std::string station_name_{"SUB/WAVE"};
  std::string ap_ssid_{"SUBWAVE-SCREEN"};
  std::function<void()> on_scan_setup_{nullptr};

  /// Set once a scan step is due; consumed by loop(). The steps are spread over
  /// scheduler timers because the coprocessor needs time between them — see
  /// request_scan() and loop().
  bool scan_start_pending_{false};

  /// Which step of request_scan()'s three-step sequence is next.
  enum class ScanPhase : uint8_t { STOP, START };
  ScanPhase scan_phase_{ScanPhase::STOP};

  /// Consecutive failed scan starts. Reset on success; bounded in loop().
  uint8_t scan_attempts_{0};
};


}  // namespace esphome::subwave_setup_web
