#pragma once

#include "esphome/core/component.h"
#include "esphome/core/hal.h"
#include "esphome/components/http_request/http_request.h"
#include "esphome/components/runtime_image/runtime_image.h"
#include "esphome/components/script/script.h"
#include <atomic>
#include <memory>
#include <string>
#include <map>
#include <vector>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#include <esp_heap_caps.h>

// The heartbeat carries and answers an OTA block, which is built with cJSON.
// Only the tag is needed here: the .cpp includes cJSON.h for the real type.
struct cJSON;

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

struct PresenterInfo {
  std::string id;
  std::string name;
  std::string role;
  std::string tagline;
  std::string avatar_url;
};

struct Byline {
  std::string presenter;
  std::string show;
  std::string avatar_url;
  std::string tagline;
  std::vector<PresenterInfo> presenters;
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
  std::string idle_mode = "stay";
  int idle_min = 30;
  int idle_pct = 20;
  bool skip_enabled = true;
};

struct ScheduleSlot {
  std::string from;
  std::string to;
  bool live = false;
  std::string day;
  int day_offset = 0;
  std::string name;
  std::string host;
  std::string host_id;
  std::string avatar_url;
  std::string tagline;
  std::vector<PresenterInfo> presenters;
};

struct PresenterModalState {
  bool open{false};
  std::vector<PresenterInfo> presenters;
  size_t current_index{0};
  std::string name;
  std::string role;
  std::string tagline;
  std::string avatar_url;
};

/**
 * PSRAM avatar cache entry holding raw PNG data downloaded from the server.
 * Stored in external PSRAM (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT).
 * Timestamps use esphome::millis() for 24-hour expiration checks.
 */
struct AvatarCacheEntry {
  // Shared ownership. The worker copies this handle under cache_mutex_ and then
  // decodes outside the lock, so clearing the cache can drop the map entry
  // without freeing a buffer that is still being decoded.
  std::shared_ptr<uint8_t> data;
  size_t length{0};
  uint32_t timestamp_ms{0};
  std::string url;
};

enum class WorkerCmdType : uint8_t {
  POLL_STATE,
  POLL_SCHEDULE,
  SEND_HEARTBEAT,
  PUSH_SETTINGS,
  SKIP_TRACK,
  CLAIM_DEVICE,
  BIND_STATION,
  FETCH_PNG,
  FETCH_COVER_ART,
  CHECK_CONNECTIVITY,
  OTA_INSTALL
};

struct WorkerSettings {
  int brightness = 70;
  char orientation[16]{"landscape"};
  char theme_mode[16]{"auto"};
  char idle_mode[16]{"stay"};
  int idle_min = 30;
  int idle_pct = 20;
  bool skip_enabled = true;

  WorkerSettings() = default;
  WorkerSettings(const StationSettings &s)
      : brightness(s.brightness),
        idle_min(s.idle_min),
        idle_pct(s.idle_pct),
        skip_enabled(s.skip_enabled) {
    strncpy(orientation, s.orientation.c_str(), sizeof(orientation) - 1);
    orientation[sizeof(orientation) - 1] = '\0';
    strncpy(theme_mode, s.theme_mode.c_str(), sizeof(theme_mode) - 1);
    theme_mode[sizeof(theme_mode) - 1] = '\0';
    strncpy(idle_mode, s.idle_mode.c_str(), sizeof(idle_mode) - 1);
    idle_mode[sizeof(idle_mode) - 1] = '\0';
  }

  StationSettings to_station_settings() const {
    StationSettings s;
    s.brightness = brightness;
    s.orientation = orientation;
    s.theme_mode = theme_mode;
    s.idle_mode = idle_mode;
    s.idle_min = idle_min;
    s.idle_pct = idle_pct;
    s.skip_enabled = skip_enabled;
    return s;
  }
};

struct WorkerCommand {
  WorkerCmdType type{WorkerCmdType::POLL_STATE};
  char url_or_path[128]{0};
  char payload[256]{0};
  void *target_ptr{nullptr};
  int slot_index{-1};
  WorkerSettings settings{};
  int rssi{0};
  char ip[32]{0};
  char bind_code[32]{0};
};

enum class WorkerResultType : uint8_t {
  STATE_UPDATED,
  SCHEDULE_UPDATED,
  HEARTBEAT_DONE,
  SETTINGS_SYNCED,
  SKIP_DONE,
  IMAGE_DECODED,
  COVER_ART_READY,
  CONNECTIVITY_RESULT,
  CLAIM_DONE,
  BIND_DONE
};

enum class Connectivity : uint8_t {
  UNKNOWN,   // not checked yet
  NO_WIFI,   // no association, or wrong password
  NO_ROUTE,  // associated, has an IP, nothing gets out
  NO_DNS,    // a route exists, but names do not resolve
  NO_SERVER, // the internet works, the station does not answer
  OK,        // all four passed
};

/**
 * What the Settings row may say about a shared firmware release.
 *
 * A VIEW, NOT A STATE MACHINE. The worker owns the install; the UI core only
 * ever reads this snapshot. Every value here is produced by the worker, so the
 * screen cannot render a phase the install has not actually reached.
 */
enum class OtaUiState : uint8_t {
  Idle,        // nothing newer is published, or the running release is current
  Available,   // a newer shared release exists; a tap installs it
  Checking,    // the tap is taken; waiting for the station to accept or refuse
  Downloading,
  Verifying,
  Installing,
  Rebooting,
  Confirming,  // restarted; waiting for the station to confirm the running image
  Failed,
};

struct OtaView {
  OtaUiState state{OtaUiState::Idle};
  int progress{0};
  std::string published_version;
  std::string installed_version;
  std::string message;
};

struct WorkerResult {
  WorkerResultType type{WorkerResultType::STATE_UPDATED};
  int status_code{0};
  void *target_img{nullptr};
  int slot_index{-1};
  Connectivity connectivity{Connectivity::UNKNOWN};
  std::string err_msg{};
  // What was fetched. Async replies can outlive the request that started them,
  // so the UI needs the URL to tell "this is the avatar on screen now" from
  // "this is the presenter the user swiped past two taps ago".
  std::string url{};

  // Staged parsed data
  NowPlaying now{};
  Byline byline{};
  StationSettings settings{};
  std::vector<ScheduleSlot> schedule_slots{};
  std::map<std::string, std::string> persona_ids{};

  int signed_in{0};
  int listening{0};
  bool is_night{true};
  bool stream_idle{false};
  int settings_rev{1};
  int64_t server_now_ms{0};
  uint32_t server_now_rx_ms{0};
  int poll_after_sec{10};
  std::string station_name{};
  std::string logo_url{};
  std::string schedule_day_label{};
  SkipState skip{};
  bool server_reachable{true};
  bool claim_refused{false};
  bool identity_lost{false};
  bool claimed{false};
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
  static constexpr int MAX_SCHEDULE_SLOTS = 5;

  SubwaveDisplay();
  ~SubwaveDisplay();

  void setup() override;
  void loop() override;
  void update() override;
  void dump_config() override;

  // Performance and resource monitoring
  void init_system_stats();
  void log_system_stats();

  void set_server_url(const std::string &url) { server_url_ = url; }
  void set_device_id(const std::string &id) { device_id_ = id; }
  void set_claim_token(const std::string &t) { claim_token_ = t; }

  // Bind to a station using a server URL and a bind code. Returns true on
  // success. Stores the resulting identity in flash.
  bool bind(const std::string &server_url, const std::string &bind_code);

  // FreeRTOS worker queue producer (0 timeout: never block UI!)
  bool enqueue_command_(const WorkerCommand &cmd);
  bool is_network_ready_() const;

  void set_setup_ap_ssid(const std::string &s) { setup_ap_ssid_ = s; }
  void set_artwork_size(int v) { artwork_size_ = v; }
  void set_art_buffer_bytes(int v) { art_buffer_bytes_ = v; }
  const std::string &setup_ap_ssid() const { return setup_ap_ssid_; }
  const std::string &setup_ap_pass() const { return setup_ap_pass_; }

  /** The bearer token, for the online_image auth header. Public for the same
   *  reason send_heartbeat() is: YAML cannot reach a private member. */
  const std::string &bearer() const { return bearer_; }
  const std::string &device_id() const { return device_id_; }
  const std::string &claim_token() const { return claim_token_; }
  const std::string &server_url() const { return server_url_; }
  /** The app's base URL, for building artwork URLs in YAML. */
  const std::string &api_base() const { return api_base_; }

  const std::string &pending_art_url() const { return pending_art_url_; }
  void clear_pending_art_url() { pending_art_url_.clear(); }

  const std::string &pending_logo_url() const { return pending_logo_url_; }
  void clear_pending_logo_url() { pending_logo_url_.clear(); }
  const std::string &shown_logo_url() const { return shown_logo_url_; }

  const std::string &pending_now_avatar_url() const { return pending_now_avatar_url_; }
  void clear_pending_now_avatar_url() { pending_now_avatar_url_.clear(); }
  const std::string &shown_now_avatar_url() const { return shown_now_avatar_url_; }
  /** The co-host's face. Empty while a show has a single host. */
  const std::string &shown_now_avatar_2_url() const { return shown_now_avatar_2_url_; }

  const std::string &pending_row_avatar_url(int i) const {
    static const std::string empty;
    return (i >= 0 && i < MAX_SCHEDULE_SLOTS) ? pending_row_avatar_url_[i] : empty;
  }
  void clear_pending_row_avatar_url(int i) {
    if (i >= 0 && i < MAX_SCHEDULE_SLOTS) pending_row_avatar_url_[i].clear();
  }

  /** Fetch a PNG from the station (chunked or Content-Length) and decode into `img`. */
  bool fetch_png(const std::string &path, esphome::runtime_image::RuntimeImage *img);

  // PSRAM Avatar Cache Management
  static constexpr uint32_t AVATAR_CACHE_TTL_MS = 86400000U;  // 24 hours (86,400,000 ms)
  void clear_avatar_cache();
  size_t avatar_cache_count() const;
  size_t avatar_cache_kb() const;

  void bind_runtime_images(
      esphome::runtime_image::RuntimeImage *station_logo,
      esphome::runtime_image::RuntimeImage *now_avatar,
      esphome::runtime_image::RuntimeImage *row_0,
      esphome::runtime_image::RuntimeImage *row_1,
      esphome::runtime_image::RuntimeImage *row_2,
      esphome::runtime_image::RuntimeImage *row_3,
      esphome::runtime_image::RuntimeImage *row_4);

  void bind_modal_avatar_image(esphome::runtime_image::RuntimeImage *modal_avatar);

  /**
   * The second face on each surface: the co-host beside the on-air portrait,
   * and the second presenter on each schedule row.
   *
   * Separate from bind_runtime_images() so that call stays a readable list of
   * the widgets every screen has, rather than every widget any screen has.
   */
  void bind_secondary_avatar_images(
      esphome::runtime_image::RuntimeImage *now_avatar_2,
      esphome::runtime_image::RuntimeImage *row_0,
      esphome::runtime_image::RuntimeImage *row_1,
      esphome::runtime_image::RuntimeImage *row_2,
      esphome::runtime_image::RuntimeImage *row_3,
      esphome::runtime_image::RuntimeImage *row_4);

  void bind_art_controls(
      esphome::runtime_image::RuntimeImage *art_in,
      esphome::runtime_image::RuntimeImage *art_out,
      bool *art_slot,
      bool *art_primed,
      bool *art_queued,
      bool *art_fading,
      esphome::script::Script<> *art_swap);

  void on_art_error();

  void set_connectivity_reported_script(esphome::script::Script<> *script);

  void request_connectivity_check();

  const std::string &bind_code() const { return bind_code_; }
  void set_bind_code(const std::string &c) { bind_code_ = c; }
  bool needs_bind() const {
    return !bind_code_.empty() && (device_id_.empty() || (claim_token_.empty() && bearer_.empty()));
  }

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
  /** True once the station has rejected this screen's identity and it was wiped.
   *  The UI reads it, opens the Bind screen, then calls ack_identity_lost(). */
  bool identity_lost() const { return identity_lost_; }
  void ack_identity_lost() { identity_lost_ = false; }
  bool server_reachable() const { return server_reachable_; }
  int64_t server_now_ms() const {
    if (server_now_ms_ <= 0) return 0;
    return server_now_ms_ + static_cast<int64_t>(esphome::millis() - server_now_rx_ms_);
  }
  uint32_t state_age_sec() const {
    if (server_now_rx_ms_ == 0) return 0;
    return (esphome::millis() - server_now_rx_ms_) / 1000u;
  }
  std::string last_error() const { return last_error_; }
  /** The station's own name, for the shows window's header. */
  std::string state_station_name() const { return station_name_; }
  std::string state_logo_url() const { return logo_url_; }
  const std::string &schedule_day_label() const { return schedule_day_label_; }
  const std::vector<ScheduleSlot> &schedule_slots() const { return schedule_slots_; }

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
  using Connectivity = subwave_display::Connectivity;

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
  bool needs_setup() const {
    return this->connectivity_ != Connectivity::OK ||
           this->device_id_.empty() ||
           (this->claim_token_.empty() && this->bearer_.empty()) ||
           this->server_url_.empty() ||
           this->claim_refused_;
  }

  /** The Skip button. Refused by the server under the same policy as a listener's. */
  void request_skip();
  /** Push a settings change made on the device's own settings screen. */
  void push_settings(const StationSettings &s);

  // -------------------------------------------------------------------------
  // Shared firmware releases, installed from this screen's own Settings.
  //
  // ONE BINARY SERVES EVERY SCREEN. The admin uploads and publishes a release
  // once; this device hears about it in its heartbeat and installs it only when
  // somebody standing at the screen asks. Nothing here installs on its own.
  //
  // THE INSTALL IS THE WORKER'S, NOT THE UI'S. request_firmware_update() records
  // the intent and returns; the download, verification, flash write and reboot
  // all happen on the Core 0 worker, because a multi-megabyte HTTPS download on
  // the LVGL core is exactly the kind of stall the whole design avoids.
  // -------------------------------------------------------------------------
  /** A mutex-free snapshot for the Settings row. Safe from the UI core. */
  OtaView ota_view() const;

  /**
   * Settings -> Update firmware. NON-BLOCKING.
   *
   * The tap is deliberate and the install is explicit: this only enqueues
   * OTA_INSTALL. A tap while an install is already running is ignored rather
   * than queued, so two taps cannot start two downloads.
   */
  void request_firmware_update();

  /**
   * Fetch the state now rather than at the next poll.
   * Enqueues POLL_STATE to background worker. Non-blocking.
   */
  void refresh_now();

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

  // Presenter detail modal controls (non-blocking)
  void open_presenter_modal_for_now();
  /**
   * The same modal, opened on a specific presenter.
   *
   * A show can be hosted by more than one person, and the now screen shows a
   * face per host. Tapping the second one must open the second bio, not always
   * the first.
   */
  void open_presenter_modal_for_now_at(size_t start_index);
  void open_presenter_modal_for_slot(int slot_index);
  void open_presenter_modal_for_slot_at(int slot_index, size_t start_index);
  void close_presenter_modal();
  void next_presenter_in_modal();
  void prev_presenter_in_modal();
  void show_presenter_in_modal(size_t index);
  const PresenterModalState &presenter_modal_state() const { return presenter_modal_state_; }

 protected:
  /**
   * Ask for the 280px portrait the modal is currently showing, if it has not
   * landed and is not already in flight. Called on open, on presenter change,
   * and from loop() so a fetch that failed retries while the modal stays open.
   */
  void ensure_modal_avatar_();
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
  int request_(const char *method, const std::string &path, const std::string &body,
               uint32_t timeout_ms, std::string *out_body);

  void poll_state_();
  void send_heartbeat_();
  bool claim_device_();
  bool parse_state_(const std::string &json, WorkerResult *res);
  bool parse_schedule_(const std::string &json, WorkerResult *res);
  void resolve_now_avatar_();

  // Background worker task (Core 0) & queues
  static void worker_task_entry_(void *arg);
  void worker_loop_();
  void handle_worker_command_(const WorkerCommand &cmd);
  void handle_worker_result_(const WorkerResult &res);
  bool enqueue_result_(WorkerResult *res);

  bool bind_device_(const std::string &server_url, const std::string &bind_code);
  Connectivity run_connectivity_ladder_();
  bool fetch_image_to_runtime_image_(const std::string &path, esphome::runtime_image::RuntimeImage *img);
  bool fetch_png_cached_(const std::string &path, esphome::runtime_image::RuntimeImage *img);
  bool fetch_cover_to_runtime_image_(const std::string &path, esphome::runtime_image::RuntimeImage *img);
  void trigger_connectivity_reported_();

  // -------------------------------------------------------------------------
  // Firmware OTA — worker-side internals.
  // -------------------------------------------------------------------------
  /**
   * The one fact that has to survive a reboot: what this device was installing.
   *
   * A screen that loses power while writing the inactive slot must be able to
   * tell, on the next boot, which outcome to report. It cannot ask the server —
   * the attempt is only identified by an id the server issued — and it cannot
   * infer it from the image alone, because "still running the old app" is both
   * "the download never finished" and "the new app crashed and rolled back".
   *
   * Trivially copyable, fixed width, no pointers: preferences store it by
   * memcpy, and a 256-byte record either lands whole or is rejected by magic.
   * Written only by the worker; read once in setup() before the worker starts.
   */
  struct OtaJournal {
    uint32_t magic;
    uint8_t phase;
    uint8_t reserved[3];
    // Every buffer is one byte larger than the server's maximum for that field:
    // ids are up to 40 characters, a requestId up to 64, a version up to 32. A
    // record that cannot hold what the station sends would truncate an id and
    // then report/install against a half-id, which the station rightly rejects.
    char attempt_id[41];
    char release_id[41];
    char request_id[65];
    char version[33];
    char sha256[65];
    char error_code[41];
    // What to SAY, which is not what the server needs. The server is told the
    // error code (an enum-like token it can count); the person who tapped the
    // row is shown the sentence, and it has to survive the reboot that the
    // failure may have caused — otherwise the retry prompt is unexplained.
    char error_message[97];
    uint32_t size_bytes;
  };

  /** The server's view of this device's live install, as a heartbeat returned it. */
  struct OtaAttemptInfo {
    std::string id;
    std::string state;
    std::string release_id;
    std::string version;
    std::string sha256;
    std::string download_url;
    uint32_t size{0};
  };

  /**
   * The copy of the row the UI core reads.
   *
   * Deliberately POD and fixed-width: it is written under a mutex from the
   * worker and copied under the same mutex by the UI, so no string is ever
   * allocated or freed while the other core might be looking. It is a COPY, not
   * a queue: the row's job is to show the latest truth, and an intermediate
   * "42%" that gets overwritten before it is painted costs nothing.
   */
  struct OtaUiSnapshot {
    uint8_t state{0};
    int progress{0};
    char published_version[32]{0};
    char installed_version[32]{0};
    char message[96]{0};
  };

  static constexpr uint32_t OTA_JOURNAL_MAGIC = 0x4F544131;  // "OTA1"
  // "SWB6". Distinct from the identity keys so a corrupt journal can never take
  // the device's credential with it, and vice versa.
  static constexpr uint32_t OTA_KEY = 0x53574236;

  // Persisted phases. These values are the on-flash format: do not renumber.
  static constexpr uint8_t OTA_J_NONE = 0;
  static constexpr uint8_t OTA_J_REQUESTED = 1;      // tapped; request not yet acknowledged
  static constexpr uint8_t OTA_J_DOWNLOADING = 2;
  static constexpr uint8_t OTA_J_VERIFYING = 3;
  static constexpr uint8_t OTA_J_INSTALLING = 4;
  static constexpr uint8_t OTA_J_REBOOTING = 5;      // boot slot switched; restart pending
  static constexpr uint8_t OTA_J_REPORT_OK = 6;
  static constexpr uint8_t OTA_J_REPORT_ROLLED_BACK = 7;
  static constexpr uint8_t OTA_J_REPORT_FAILED = 8;

  /** Boot-time setup: mutex, journal, running-image fingerprint, reconciliation. */
  void ota_init_();
  /** Turn a journal left by the previous boot into a report and a visible state. */
  bool ota_boot_reconcile_();
  /** The whole install, on the worker. Returns false if nothing was installed. */
  bool ota_install_();
  /**
   * Fingerprint the image this device is running: descriptor version, the
   * whole-file SHA-256 the station publishes, and the slot label.
   *
   * THE HASH COVERS THE APPENDED DIGEST TOO. The station hashes the exact file
   * it serves — header, segments, checksum and the 32-byte SHA-256 the image
   * carries — so hashing only the image body here would never match.
   */
  bool ota_read_running_(std::string *version, std::string *sha, std::string *slot);

  /**
   * Whether this boot has been declared good.
   *
   * The bootloader keeps a freshly installed image on probation until the app
   * marks itself valid (ESPHome does that after a minute). Before then a crash
   * or a reset rolls the bootloader back to the previous slot. Calling a
   * just-started image a success would therefore tell the station that an
   * install worked during exactly the window in which it can still be undone.
   */
  bool ota_boot_validated_();

  void ota_journal_save_();
  void ota_journal_load_();
  void ota_journal_clear_();
  void ota_publish_(OtaUiState state, int progress, const std::string &message);
  void ota_note_published_(const std::string &release_id, const std::string &version,
                           const std::string &sha, uint32_t size);
  void ota_note_installed_(const std::string &version, const std::string &sha, const std::string &slot);
  /** Re-derive the row from the catalog and the running image (no install active). */
  void ota_refresh_view_();
  /** Add the OTA block to a heartbeat, including any journal-driven report. */
  void ota_prepare_heartbeat_(cJSON *ota);
  /** Apply the response's published/attempt/notice to the catalog and the row. */
  void ota_apply_heartbeat_(cJSON *ota, OtaAttemptInfo *attempt_out, std::string *notice_out);
  /** Record a failure on the row and in the journal, so it survives a reset. */
  void ota_fail_(const std::string &message, const char *error_code);
  /** The tap, on the worker: refuse, resume, or start a fresh request. */
  void ota_handle_tap_();
  /** Ask the station to reserve an attempt for the published release. */
  void ota_begin_request_();
  /**
   * Continue an install this device had already asked for.
   *
   * Called after a heartbeat and at the end of a request: the journal says an
   * install was intended, and the attempt is downloadable. It never starts one
   * on its own — a heartbeat that merely announces a release must not install
   * it, because nobody tapped.
   */
  void ota_resume_();
  /**
   * One heartbeat, OTA block included. Returns the HTTP status (or -1).
   *
   * The report, when there is one, comes from the journal rather than a caller
   * argument: there is exactly one source of truth for "what am I owed to tell
   * the station", and it is the record that survives a reset.
   */
  int send_heartbeat_request_(const char *ip, int rssi, int *settings_rev,
                              OtaAttemptInfo *attempt_out, std::string *notice_out);

  esphome::runtime_image::RuntimeImage *station_logo_image_{nullptr};
  esphome::runtime_image::RuntimeImage *now_avatar_image_{nullptr};
  esphome::runtime_image::RuntimeImage *now_avatar_2_image_{nullptr};
  esphome::runtime_image::RuntimeImage *row_avatar_images_[MAX_SCHEDULE_SLOTS]{nullptr};
  esphome::runtime_image::RuntimeImage *row_avatar2_images_[MAX_SCHEDULE_SLOTS]{nullptr};
  esphome::runtime_image::RuntimeImage *art_in_image_{nullptr};
  esphome::runtime_image::RuntimeImage *art_out_image_{nullptr};
  esphome::runtime_image::RuntimeImage *modal_avatar_image_{nullptr};
  bool *art_slot_{nullptr};
  bool *art_primed_{nullptr};
  bool *art_queued_{nullptr};
  bool *art_fading_{nullptr};
  esphome::script::Script<> *art_swap_script_{nullptr};
  esphome::script::Script<> *connectivity_reported_script_{nullptr};

  TaskHandle_t worker_task_handle_{nullptr};
  QueueHandle_t worker_cmd_queue_{nullptr};
  QueueHandle_t ui_result_queue_{nullptr};

  bool settings_pending_push_{false};
  uint32_t settings_push_ms_{0};
  bool cover_in_flight_{false};
  bool first_loop_{true};

  // The credential, in flash. A fixed-size buffer because preferences are stored
  // by memcpy of a trivially-copyable type — see the note on save_token_().
  static constexpr size_t TOKEN_BYTES = 65;
  static constexpr uint32_t TOKEN_KEY = 0x53574231;  // "SWB1"

  // Flash storage for the bound identity. A standard image carries none of
  // these at compile time; the device collects them during setup and stores
  // them here. Each gets its own preference key so a partial write (power cut
  // mid-save) cannot corrupt the whole identity.
  static constexpr size_t URL_BYTES = 256;
  static constexpr size_t ID_BYTES = 65;
  static constexpr size_t CLAIM_BYTES = 65;
  static constexpr uint32_t URL_KEY = 0x53574232;    // "SWB2"
  static constexpr uint32_t DEVICE_ID_KEY = 0x53574233;  // "SWB3"
  static constexpr uint32_t CLAIM_TOKEN_KEY = 0x53574234;  // "SWB4"

  static constexpr size_t BIND_CODE_BYTES = 16;
  static constexpr uint32_t BIND_CODE_KEY = 0x53574235;  // "SWB5"
  void save_token_();
  void load_token_();

  void save_identity_();
  void load_identity_from_flash_();
  /** Forget the device id, claim token and bearer (RAM and flash). Keeps server_url_
   *  so the bind screen can pre-fill it. Raises identity_lost_ for the UI. */
  void drop_identity_(const char *why);
  void save_bind_code_();
  void load_bind_code_();

  std::string server_url_;
  std::string device_id_;
  std::string claim_token_;
  std::string setup_ap_ssid_{"SUBWAVE-SCREEN"};
  std::string setup_ap_pass_;
  std::string api_base_;
  std::string bearer_;
  std::string last_error_;

  int artwork_size_{640};
  uint32_t art_buffer_bytes_{65536};
  int settings_rev_{1};
  int64_t server_now_ms_{0};
  uint32_t server_now_rx_ms_{0};
  uint32_t backoff_until_ms_{0};
  uint8_t failure_count_{0};
  bool settings_dirty_{false};
  int poll_after_sec_{10};
  std::string station_name_;
  std::string logo_url_;
  std::string schedule_day_label_;
  std::vector<ScheduleSlot> schedule_slots_;
  uint32_t last_schedule_poll_ms_{0};
  // The cover the server just named. Held here until the YAML layer has set it
  // on the incoming online_image, because C++ cannot reach that object directly.
  std::string pending_art_url_;
  std::string shown_art_url_;
  std::string pending_logo_url_;
  std::string shown_logo_url_;
  std::string pending_now_avatar_url_;
  std::string shown_now_avatar_url_;
  std::string pending_now_avatar_2_url_;
  std::string shown_now_avatar_2_url_;
  std::string pending_row_avatar_url_[MAX_SCHEDULE_SLOTS];
  std::string shown_row_avatar_url_[MAX_SCHEDULE_SLOTS];
  std::string pending_row_avatar2_url_[MAX_SCHEDULE_SLOTS];
  std::string shown_row_avatar2_url_[MAX_SCHEDULE_SLOTS];
  std::map<std::string, std::string> persona_ids_;
  PresenterModalState presenter_modal_state_{};
  // Two URLs, not one: the modal's 280px avatar is requested before it exists.
  // `requested` is the fetch in flight, `shown` is the one that actually landed
  // and is safe to paint. Collapsing them into one pointer is what made a failed
  // fetch permanent — the URL was recorded before the queue accepted the work,
  // so every later tap was suppressed and the well kept the 88px thumbnail.
  std::string modal_avatar_requested_url_;
  std::string shown_modal_avatar_url_;
  uint32_t modal_avatar_retry_ms_{0};
  std::string bind_code_;

  // ---- shared firmware releases -------------------------------------------
  //
  // The catalog is what the station last reported, and the running block is
  // what this device last hashed out of its own flash. Both are worker facts:
  // the UI only ever sees the snapshot below.
  std::string ota_pub_release_id_;
  std::string ota_pub_version_;
  std::string ota_pub_sha_;
  uint32_t ota_pub_size_{0};
  std::string ota_run_version_;
  std::string ota_run_sha_;
  std::string ota_run_slot_;
  // The release that failed most recently, so a later heartbeat cannot replace
  // a retry prompt with an "available" one before the operator has seen it.
  std::string ota_failed_release_id_;
  // The live attempt, as the last heartbeat described it. Empty id means none.
  OtaAttemptInfo ota_attempt_{};
  // One install at a time. Set for the whole of ota_install_(); checked by the
  // command handler so a queued second tap is dropped rather than started.
  bool ota_install_running_{false};
  // The record that survives a reset mid-install. Worker-only.
  OtaJournal ota_journal_{};

  // Read on the UI core, written on the worker. Short critical sections only.
  mutable SemaphoreHandle_t ota_ui_mutex_{nullptr};
  mutable OtaUiSnapshot ota_ui_{};

  // PSRAM Avatar Cache
  std::map<std::string, AvatarCacheEntry> avatar_cache_{};
  SemaphoreHandle_t cache_mutex_{nullptr};
  // Mirrors of the map, updated under cache_mutex_. Read from the UI core, so
  // they are atomic: the stats label must never wait on the cache lock.
  std::atomic<uint32_t> avatar_cache_count_{0};
  std::atomic<uint32_t> avatar_cache_bytes_{0};

  bool claimed_{false};
  bool server_reachable_{false};
  bool claim_refused_{false};
  bool identity_lost_{false};
  Connectivity connectivity_{Connectivity::UNKNOWN};
  bool stream_idle_{false};
  bool is_night_{true};
  int signed_in_{0};
  int listening_{0};

  NowPlaying now_;
  Byline byline_;
  SkipState skip_;
  StationSettings settings_;

  // Performance and resource monitoring
  uint32_t last_stats_ms_{0};
  uint32_t last_loop_ms_{0};
  uint32_t loop_count_{0};
  uint32_t max_loop_lag_ms_{0};
  uint32_t last_tick_total_[2]{0, 0};
  uint32_t last_tick_idle_[2]{0, 0};
  uint32_t irq_low_start_ms_{0};
  uint32_t last_irq_warn_ms_{0};
};

}  // namespace subwave_display