#pragma once

#include "esphome/core/component.h"
#include "esphome/components/http_request/http_request.h"
#include "esphome/components/api/api_server.h"
#include "esphome/components/web_server_idf/web_server_idf.h"
#include <string>
#include <map>

namespace subwave_display {

/**
 * What the screen renders, as the server sent it.
 *
 * Mirrors lib/device-types.ts. That file is the contract; this is the consumer,
 * and the two are changed together. Anything the screen can show lives here and
 * nothing is computed locally — the device receives a finished label rather than
 * a mode to interpret, which is what stops the wall and the browser disagreeing.
 */
struct NowPlaying {
  std::string subsonic_id;
  std::string title;
  std::string artist;
  std::string album;
  std::string art_url;
  int64_t started_at_ms = 0;
  int duration_sec = 0;
  bool live = false;
};

struct Byline {
  std::string presenter;
  std::string show;
  int64_t on_air_for_sec = -1;
  int64_t ends_in_sec = -1;
  bool live = false;
};

struct SkipState {
  bool shown = false;
  bool enabled = false;
  std::string label;
  int cooldown_sec = 0;
  bool locked = false;
};

struct StationSettings {
  int brightness = 70;
  std::string orientation = "landscape";
  std::string theme_mode = "auto";
  std::string idle_mode = "dim";
  int idle_min = 15;
  int idle_pct = 20;
  bool skip_enabled = true;
};

/**
 * The screen's half of the station.
 *
 * ONE HOST, AND IT IS OURS. server_url is the app's public URL and nothing else.
 * The screen never learns the station backend's address, has no setting for it,
 * and cannot be pointed at one — everything is proxied through /api/devices, so
 * moving the backend is invisible to every screen ever flashed. That insulation
 * is deliberate and it is why there is no backend URL in the YAML.
 *
 * A SCREEN IS NOT A LISTENER. It authenticates with a bearer token issued at
 * claim, it never presents a session, and it never appears in the signed-in count
 * or the listener count. Nothing in here writes to presence and there is no code
 * path that could: the endpoints it calls are read-only apart from its own
 * heartbeat, and the server enforces the same rule independently.
 *
 * THE DEVICE'S WHOLE PERSISTENT STATE is its WiFi credentials and this token.
 * Everything else is a cache the server re-sends on demand, which is why a
 * factory reset costs nothing but a re-flash.
 */
/**
 * Parented<HttpRequestComponent>, NOT HttpRequestComponent itself.
 *
 * In 2026.7 the client was split apart: `HttpRequestComponent` no longer holds a
 * `client_` member and is no longer something a component inherits to make
 * requests. It *is* the thing that makes them — `get()`, `post()` and `start()`
 * all live on it — and a consumer holds a pointer to it via Parented, exactly as
 * `online_image` does.
 *
 * Inheriting it instead would compile as a second, empty HTTP component: it
 * would build, it would never be configured, and every request would go nowhere.
 */
class SubwaveDisplay
    : public esphome::PollingComponent,
      public esphome::Parented<esphome::http_request::HttpRequestComponent> {
 protected:
  /** The shared client. Null before setup, which is why no request may be made early. */
  esphome::http_request::HttpRequestComponent *http() { return this->get_parent(); }
 public:
  void setup() override;
  void loop() override;
  void update() override;
  void dump_config() override;

  void set_server_url(const std::string &url) { server_url_ = url; }
  void set_device_id(const std::string &id) { device_id_ = id; }
  void set_claim_token(const std::string &t) { claim_token_ = t; }
  void set_setup_ap_ssid(const std::string &s) { setup_ap_ssid_ = s; }
  void set_artwork_size(int v) { artwork_size_ = v; }
  void set_art_buffer_bytes(int v) { art_buffer_bytes_ = v; }
  const std::string &get_setup_ap_ssid_() const { return setup_ap_ssid_; }

  // For the screens: the current state, and the artwork fetch to start.
  const NowPlaying &now_playing() const { return now_; }
  const Byline &byline() const { return byline_; }
  const SkipState &skip() const { return skip_; }
  const StationSettings &settings() const { return settings_; }
  /**
   * The settings as a DRAFT.
   *
   * The settings screen edits this and then calls push_settings(), so the server
   * is what actually decides — it clamps, it bumps the revision, and it is the
   * authority the next poll will bring back. Keeping the mutable form separate
   * from the const one means everything that only READS the settings still
   * cannot write them by accident.
   */
  StationSettings &settings_draft() { return settings_; }
  int signed_in() const { return signed_in_; }
  int listening() const { return listening_; }
  bool stream_idle() const { return stream_idle_; }
  bool is_night() const { return is_night_; }
  bool claimed() const { return claimed_; }
  bool server_reachable() const { return server_reachable_; }
  int64_t server_now_ms() const { return server_now_ms_; }
  std::string last_error() const { return last_error_; }
  /** The station's own name, for the shows window's header. */
  std::string state_station_name() const { return station_name_; }
  std::string state_logo_url() const { return logo_url_; }

  // -------------------------------------------------------------------------
  // The connectivity ladder.
  //
  // WHY NOT JUST ASK WHETHER THE DEVICE IS CONNECTED. Because `wifi.connected`
  // is true on a guest network with no route out, and on a network whose
  // captive portal has answered the DHCP request but intercepts every DNS
  // query after it. Both look exactly like a working network to anything that
  // only checks the link, and both leave a screen that will never show a song.
  // The reference firmware infers connectivity from the link plus a Home
  // Assistant API this device does not have.
  //
  // The four results, in the order they are tested. Each one exists because it
  // fails for a different reason and the fix differs — "it doesn't work" would
  // leave somebody holding a phone stuck.
  enum class Connectivity : uint8_t {
    UNKNOWN,   // not checked yet
    NO_WIFI,   // no association, or wrong password
    NO_ROUTE,  // associated, has an IP, nothing gets out
    NO_DNS,    // a route exists, but names do not resolve
    NO_SERVER, // the internet works, the station does not answer
    OK,        // all four passed
  };

  /** Run the ladder. Blocking — a few seconds. Call it from a script delay. */
  Connectivity check_connectivity();

  /** The result of the last run. */
  Connectivity connectivity() const { return this->connectivity_; }

  /**
   * What to tell the person standing in front of the screen.
   *
   * Names the CAUSE, because the cause is invisible from the screen's side. The
   * guest-network cases in particular: the device has an IP and looks fine, and
   * the only thing that tells you is that something is intercepting traffic.
   * A message that says which one saves somebody twenty minutes.
   */
  const char *connectivity_message(Connectivity c) const;

  /** True when setup should be demanded rather than merely offered. */
  bool needs_setup() const { return this->connectivity_ != Connectivity::OK; }

  /** Fetch the cover. Decoded into PSRAM, never on the tick that swaps windows. */
  void request_artwork(const std::string &url);
  /** The Skip button. Refused by the server under the same policy as a listener's. */
  void request_skip();
  /** Push a settings change made on the device's own settings screen. */
  void push_settings(const StationSettings &s);

  /**
   * Fetch the state now rather than at the next poll.
   *
   * For a user action that must feel answered — a skip, a setting pushed from the
   * device's own screen. Without it the server's answer arrives up to a poll
   * interval later, and the gap between pressing a button and seeing anything is
   * indistinguishable from the button being broken.
   *
   * Does not claim to be fast. request_() reads the response to completion, so
   * this blocks for the round trip — which is why it is called from a script
   * action rather than from a touch handler.
   */
  void refresh_now() { this->poll_state_(); }

  /**
   * Tell the station the screen is alive. Driven by a YAML interval.
   *
   * Public because the interval is YAML and the method is not — `id()` is a
   * lambda-local helper, so a private member is unreachable from the one place
   * that should be calling it. That is the same reason bind_backlight() exists.
   *
   * IT WAS PRIVATE AND UNCALLED, which meant the screen never sent a heartbeat
   * at all: the station's device list showed a screen that was configured and
   * silent, and there was no way for anybody to tell that apart from one that had
   * been unplugged.
   */
  void send_heartbeat();
  /** Register the custom web handler for the setup wizard. */
  void register_web_handler_();

 protected:
  /**
   * Which request a response belongs to.
   *
   * THE 2026.7 HTTP API IS A STREAM, NOT A CALLBACK. `perform()` hands back a
   * container that you read until `is_read_complete()`; the old
   * `set_body`/`set_header`/`start`/`register_response_callback` chain is gone.
   *
   * That means every endpoint needs somewhere for its response to LAND once the
   * body has been read, and "attach a different lambda at each call site" is five
   * copies of the same ceremony. So there is one request_() and one dispatch
   * table: a request says which kind it is, and handle_() decides what a given
   * status and body mean for it.
   */
  enum class Req : uint8_t { CLAIM, STATE, ARTWORK, SKIP, HEARTBEAT, SETTINGS };

  void request_(Req kind, const char *method, const std::string &path, const std::string &body, uint32_t timeout_ms);
  void handle_(Req kind, int status, const std::string &body);

  void poll_state_();
  void send_heartbeat_();
  bool claim_device_();
  void parse_state_(const std::string &json);

  // The credential, in flash. A fixed-size buffer because preferences are stored
  // by memcpy of a trivially-copyable type — see the note on save_token_().
  static constexpr size_t TOKEN_BYTES = 65;
  static constexpr uint32_t TOKEN_KEY = 0x53574231;  // "SWB1"
  void save_token_();
  void load_token_();

  std::string server_url_;
  std::string device_id_;
  std::string claim_token_;
  std::string setup_ap_ssid_{"SUBWAVE-SCREEN"};
  std::string api_base_;
  std::string bearer_;
  std::string last_error_;

  int artwork_size_{640};
  uint32_t art_buffer_bytes_{65536};
  int settings_rev_{1};
  // The STATION's clock, not the device's. A screen with no RTC drifts, and a
  // wall display whose schedule is two minutes out is worse than one showing
  // nothing — so the server's time is authoritative and this is refreshed with
  // every state poll. Declared here because `server_now_ms()` reads it and was
  // reading a member that did not exist.
  int64_t server_now_ms_{0};
  int poll_after_sec_{10};
  std::string station_name_;
  std::string logo_url_;
  // The cover currently on the glass. Compared against the incoming art URL so a
  // ten-second poll does not pull the same JPEG down again every time.
  std::string art_url_shown_;

  bool claimed_{false};
  bool server_reachable_{false};
  Connectivity connectivity_{Connectivity::UNKNOWN};
  bool stream_idle_{false};
  bool is_night_{true};
  int signed_in_{0};
  int listening_{0};

  NowPlaying now_;
  Byline byline_;
  SkipState skip_;
  StationSettings settings_;
};

}  // namespace subwave_display