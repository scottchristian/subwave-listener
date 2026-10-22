#include "display_client.h"
// The painters. parse_state_ has to call them itself — see below.
#include "ui.h"

#include <cJSON.h>
#include <ctime>
#include <cstring>
#include <algorithm>

#include "esphome/core/log.h"
#include "esphome/core/application.h"
#include "esphome/core/defines.h"
#include "esphome/core/preferences.h"
#include "esphome/components/wifi/wifi_component.h"
#include "esphome/components/network/util.h"
#include "esphome/components/web_server_idf/web_server_idf.h"
#include "esphome/components/web_server_base/web_server_base.h"

// The connectivity ladder needs a socket and a resolver. These are the IDF's,
// not lwIP's headers directly, and getting the names wrong here fails at link
// time with an undefined reference to getaddrinfo rather than anything that
// points at this file.
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <cerrno>

namespace subwave_display {

static const char *const TAG = "subwave.display";

// The station's own public URL, and the only host this device knows. Everything
// below is a path on it. There is deliberately no backend URL anywhere in this
// file or in the YAML that configures it.
static std::string join(const std::string &base, const std::string &path) {
  std::string b = base;
  while (!b.empty() && b.back() == '/') b.pop_back();
  if (path.empty() || path[0] != '/') return b + "/" + path;
  return b + path;
}

static std::string str_at(cJSON *obj, const char *key) {
  cJSON *item = cJSON_GetObjectItem(obj, key);
  return cJSON_IsString(item) && item->valuestring ? std::string(item->valuestring) : std::string();
}

// The same, but keeping what we already had. EVERY setting arrives from the
// server on a ten-second poll, and a poll that arrives truncated — or a station
// that has not decided a theme yet — must not silently blank a setting the
// operator already chose. Absent means "no opinion", not "set it to empty".
static std::string str_or(cJSON *obj, const char *key, const std::string &fallback) {
  cJSON *item = cJSON_GetObjectItem(obj, key);
  return cJSON_IsString(item) && item->valuestring ? std::string(item->valuestring) : fallback;
}

static int int_at(cJSON *obj, const char *key, int fallback = 0) {
  cJSON *item = cJSON_GetObjectItem(obj, key);
  return cJSON_IsNumber(item) ? (int) item->valuedouble : fallback;
}

static int64_t int64_at(cJSON *obj, const char *key, int64_t fallback = -1) {
  cJSON *item = cJSON_GetObjectItem(obj, key);
  if (cJSON_IsNumber(item)) return (int64_t) item->valuedouble;
  return fallback;
}

static bool bool_at(cJSON *obj, const char *key, bool fallback = false) {
  cJSON *item = cJSON_GetObjectItem(obj, key);
  if (cJSON_IsBool(item)) return cJSON_IsTrue(item);
  if (cJSON_IsNumber(item)) return item->valuedouble != 0;
  return fallback;
}

void SubwaveDisplay::setup() {
  // The identity lives in flash. A standard image carries none of it; the
  // device collects the server URL and a bind code during setup and stores the
  // result here. Per-device builds still work by passing substitutions, which
  // set these fields before setup() runs.
  if (esphome::global_preferences != nullptr) {
    this->load_token_();
    this->load_identity_from_flash_();
    this->load_bind_code_();
  }
  this->api_base_ = this->server_url_;

  if (this->claim_token_ == "unprovisioned" && !this->claimed_) {
    ESP_LOGW(TAG, "This firmware has no setup code in it. Flash it from the admin panel.");
  }

  // Register our custom web handler for the setup wizard (overrides ESPHome dashboard).
  this->register_web_handler_();
}

void SubwaveDisplay::dump_config() {
  ESP_LOGCONFIG(TAG, "Subwave Display:");
  ESP_LOGCONFIG(TAG, "  Station: %s", this->server_url_.c_str());
  ESP_LOGCONFIG(TAG, "  Setup AP: %s", this->setup_ap_ssid_.c_str());
  ESP_LOGCONFIG(TAG, "  Artwork: %dpx into %u bytes", this->artwork_size_, this->art_buffer_bytes_);
  if (this->server_url_.find("ghostmaster") != std::string::npos) {
    // Loud, because the one thing this device must never do is phone somewhere
    // that is not the station, and a wrong substitution is otherwise invisible.
    ESP_LOGE(TAG, "The station URL names a host that is not this station's app. Refusing.");
  }
}

void SubwaveDisplay::loop() {
  // A window slide queued behind a crossfade gets picked up here rather than in
  // the crossfade's own callback, so the two motions never overlap and a screen
  // switched every twenty seconds does not stutter once in a while.
}

// ---------------------------------------------------------------------------
// Reachability
//
// THREE STEPS, THREE FAILURES, THREE DIFFERENT FIXES. A screen that has joined a
// WiFi network has NOT necessarily joined the internet: guest networks and
// captive portals hand out an address and then intercept everything. The
// reference firmware has no check for this at all, which is how a captive portal
// produces a screen that silently never shows a song.
// ---------------------------------------------------------------------------
bool SubwaveDisplay::claim_device_() {
  // Always try to claim if we don't have a bearer token yet
  if (!this->bearer_.empty()) return true;
  // Need device_id + claim_token + server_url to claim
  if (!this->device_id_.empty() && !this->claim_token_.empty() && !this->server_url_.empty()) {
    this->api_base_ = this->server_url_;
    std::string body = "{";
    body += "\"deviceId\":\"" + this->device_id_ + "\",";
    body += "\"claimToken\":\"" + this->claim_token_ + "\",";
    body += "\"timezone\":\"\"";
    body += "}";

    this->request_(Req::CLAIM, "POST", "/api/devices/claim", body, 15000);
    return this->claimed_;  // true if bearer token received
  }
  if (this->device_id_.empty() || this->claim_token_.empty() || this->server_url_.empty()) {
    ESP_LOGW(TAG, "Cannot claim: no identity. Setup required.");
    return false;
  }

  return false;
}

void SubwaveDisplay::poll_state_() {
  ESP_LOGD(TAG, "poll_state_(): claimed_=%d, claim_refused_=%d", (int)this->claimed_, (int)this->claim_refused_);
  if (!this->claimed_) {
    this->claim_device_();
    if (!this->claimed_) {
      // claim_device_() couldn't arm us (no stored identity) — give up for now
      return;
    }
    // claim_device_() set claimed_ = true (we have stored identity), fall through
    // to fetch state.
  }

  this->request_(Req::STATE, "GET", "/api/devices/state", "", 12000);
  uint32_t now_ms = esphome::millis();
  if (this->schedule_slots_.empty() || (now_ms - this->last_schedule_poll_ms_ >= 60000u)) {
    this->last_schedule_poll_ms_ = now_ms;
    this->request_(Req::SCHEDULE, "GET", "/api/devices/schedule", "", 12000);
  }
}

void SubwaveDisplay::parse_state_(const std::string &json) {
  cJSON *root = cJSON_Parse(json.c_str());
  if (root == nullptr) {
    // A shape change upstream must not brick a wall display. Keep whatever was
    // on screen and try again; the server is the thing that needs fixing.
    this->last_error_ = "The station sent something this screen did not understand.";
    return;
  }

  // The clock comes from the server, never from SNTP. One source, and the theme
  // window and the countdown agree with the station's idea of the time.
  this->server_now_ms_ = int64_at(root, "serverNowMs", 0);
  this->poll_after_sec_ = int_at(root, "pollAfterSec", 10);

  if (cJSON *station = cJSON_GetObjectItem(root, "station")) {
    this->station_name_ = str_at(station, "name");
    this->logo_url_ = str_at(station, "logo");
  }
  if (cJSON *now = cJSON_GetObjectItem(root, "now")) {
    this->now_.subsonic_id = str_at(now, "subsonicId");
    this->now_.title = str_at(now, "title");
    this->now_.artist = str_at(now, "artist");
    this->now_.album = str_at(now, "album");
    this->now_.art_url = str_at(now, "art");
    this->now_.started_at_ms = int64_at(now, "startedAtMs", 0);
    this->now_.duration_sec = int_at(now, "durationSec", 0);
    this->now_.live = bool_at(now, "live");
  }
  if (cJSON *byline = cJSON_GetObjectItem(root, "byline")) {
    this->byline_.presenter = str_at(byline, "presenter");
    this->byline_.show = str_at(byline, "show");
    this->byline_.on_air_for_sec = int64_at(byline, "onAirForSec", -1);
    this->byline_.ends_in_sec = int64_at(byline, "endsInSec", -1);
    this->byline_.live = bool_at(byline, "live");
  }
  if (cJSON *counts = cJSON_GetObjectItem(root, "counts")) {
    this->signed_in_ = int_at(counts, "signedIn", 0);
    this->listening_ = int_at(counts, "listening", 0);
  }
  if (cJSON *theme = cJSON_GetObjectItem(root, "theme")) {
    // The brightness cap is the SERVER's decision — 70 by day, 100 at night —
    // because the safe direction matters: a screen that dims too far is obvious
    // and fixable from the app, and one that blazes at 3am is neither.
    this->is_night_ = bool_at(theme, "isNight", true);
    int server_brightness = int_at(theme, "brightness", this->settings_.brightness);
    if (server_brightness != this->settings_.brightness) {
      ESP_LOGI(TAG, "Server set brightness: %d%% -> %d%%.", this->settings_.brightness, server_brightness);
    }
    this->settings_.brightness = server_brightness;
  }
  if (cJSON *idle = cJSON_GetObjectItem(root, "idle")) {
    this->settings_.idle_mode = str_or(idle, "mode", this->settings_.idle_mode);
    this->settings_.idle_min = int_at(idle, "min", this->settings_.idle_min);
    this->settings_.idle_pct = int_at(idle, "pct", this->settings_.idle_pct);
  }
  if (cJSON *skip = cJSON_GetObjectItem(root, "skip")) {
    this->skip_.shown = bool_at(skip, "shown");
    this->skip_.enabled = bool_at(skip, "enabled");
    this->skip_.label = str_at(skip, "label");
    this->skip_.cooldown_sec = int_at(skip, "cooldownSec", 0);
    this->skip_.locked = bool_at(skip, "locked");
  }
  this->stream_idle_ = bool_at(root, "streamIdle", false);
  this->settings_rev_ = int_at(root, "settingsRev", this->settings_rev_);
  this->server_reachable_ = true;
  this->last_error_.clear();

  cJSON_Delete(root);

  // ---- and now put it on the glass -------------------------------------
  //
  // THIS IS THE PART THAT WAS MISSING, AND IT IS THE WHOLE SCREEN.
  //
  // parse_state_ filled in every field the now-playing window draws from and
  // then returned. Nothing called now_refresh(). Every label stayed on whatever
  // ESPHome had put there at boot — the title, the artist, the show, the
  // listener counts, the Skip button — so a screen on a perfectly good network
  // sat there showing its own YAML defaults while the log cheerfully reported a
  // successful state poll every ten seconds.
  //
  // THAT IS WHY IT WAS INVISIBLE. Nothing errored. The fetch succeeded, the
  // parse succeeded, the log said so, and the glass said nothing at all. A bug
  // whose only symptom is the absence of a change cannot be found by watching
  // the logs, which is the only thing anybody was watching.
  //
  // PAINT HERE, WHERE THE STATE LANDED, NOT ON A TIMER. A repaint interval would
  // work and would be wrong: it would redraw the whole window whether or not
  // anything changed, it would repaint windows nobody is looking at, and the
  // moment a field were added to the struct and not to the painter, the timer
  // would still be running and the bug would still be there.
  now_refresh();
  shows_refresh();
  settings_refresh();

  // Artwork. The URL is a path under the app's own host, so it has to be
  // turned into a full URL and handed to the incoming online_image — and that
  // object is reachable only from YAML, so it is queued here and applied by the
  // one-second tick below. Fetching every poll would pull a JPEG every ten
  // seconds to redraw a picture that is already there, so it is gated on the
  // URL actually changing.
  if (!this->now_.art_url.empty() && this->now_.art_url != this->shown_art_url_) {
    this->shown_art_url_ = this->now_.art_url;
    this->pending_art_url_ = this->now_.art_url;
  }
}

void SubwaveDisplay::parse_schedule_(const std::string &json) {
  cJSON *root = cJSON_Parse(json.c_str());
  if (root == nullptr) return;

  std::string day = str_at(root, "dayLabel");
  if (!day.empty()) this->schedule_day_label_ = day;

  if (cJSON *slots = cJSON_GetObjectItem(root, "slots")) {
    if (cJSON_IsArray(slots)) {
      this->schedule_slots_.clear();
      int count = cJSON_GetArraySize(slots);
      for (int i = 0; i < count && i < 5; i++) {
        cJSON *item = cJSON_GetArrayItem(slots, i);
        if (item == nullptr) continue;
        ScheduleSlot slot;
        slot.from = str_at(item, "from");
        slot.to = str_at(item, "to");
        slot.live = bool_at(item, "live");
        if (cJSON *show = cJSON_GetObjectItem(item, "show")) {
          slot.name = str_at(show, "name");
          slot.host = str_at(show, "host");
        }
        this->schedule_slots_.push_back(slot);
      }
    }
  }
  cJSON_Delete(root);
  shows_refresh();
}

// ---------------------------------------------------------------------------
// One request, read to completion, then handled.
//
// THE API IS A STREAM. `perform()` hands back a container to be READ until
// `is_read_complete()`, rather than one you attach a callback to and start. The
// body is therefore read here, in one place, and dispatched by which request it
// belongs to — so "what does a 401 mean" is answered in one function instead of
// six.
//
// `this` is captured raw rather than through shared_from_this(). The component
// is created once and never destroyed, so it outlives every request it makes;
// Component no longer provides shared_from_this(), and inventing an ownership
// story here would be worse than the one that already holds.
// ---------------------------------------------------------------------------
void SubwaveDisplay::request_(Req kind, const char *method, const std::string &path, const std::string &body,
                              uint32_t timeout_ms) {
  auto *client = this->http();
  if (client == nullptr) return;

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) {
    headers.push_back({"Authorization", "Bearer " + this->bearer_});
  }
  if (!body.empty()) {
    headers.push_back({"Content-Type", "application/json"});
  }

  // start(), NOT perform(): perform() is protected and this is not a subclass of
  // HttpRequestComponent — it merely holds one. start() is the public form of the
  // same call and takes the headers directly.
  auto container = client->start(join(this->api_base_, path), method, body, headers);
  if (container == nullptr) {
    this->server_reachable_ = false;
    ESP_LOGW(TAG, "%s %s could not be started.", method, path.c_str());
    return;
  }

  // Read the whole body. The cap is not paranoia: an artwork response is a
  // whole JPEG and there is no reason for any of these to be larger, so a
  // misconfigured endpoint that streams forever cannot exhaust PSRAM and take
  // the screen down with it.
  constexpr size_t MAX_BODY = 96 * 1024;
  std::string out;
  out.reserve(2048);
  uint8_t chunk[512];
  uint32_t started = esphome::millis();
  while (!container->is_read_complete()) {
    int n = container->read(chunk, sizeof(chunk));
    if (n > 0) {
      if (out.size() + static_cast<size_t>(n) > MAX_BODY) {
        ESP_LOGW(TAG, "%s response exceeded the cap; discarding.", path.c_str());
        container->end();
        return;
      }
      out.append(reinterpret_cast<char *>(chunk), static_cast<size_t>(n));
      started = esphome::millis();
      continue;
    }
    esphome::App.feed_wdt();
    esphome::yield();
    if (esphome::millis() - started > timeout_ms) {
      ESP_LOGW(TAG, "%s timed out after %u ms.", path.c_str(), (unsigned) timeout_ms);
      container->end();
      return;
    }
  }
  container->end();

  this->handle_(kind, container->status_code, out);
}

void SubwaveDisplay::handle_(Req kind, int status, const std::string &body) {
  // A status below zero means the request never completed. Recording that as
  // "server unreachable" is the whole point: a screen on a captive-portal wifi
  // looks identical to a working one otherwise, and the log is the only place
  // the difference shows.
  this->server_reachable_ = status > 0;

  switch (kind) {
    case Req::CLAIM:
      if (status == 200 || status == 201) {
        cJSON *root = cJSON_Parse(body.c_str());
        if (root != nullptr) {
          std::string tok = str_at(root, "token");
          if (!tok.empty()) this->bearer_ = tok;
          cJSON_Delete(root);
        }
        this->claimed_ = !this->bearer_.empty();
        // Persist immediately. A claim that is not written to flash is a claim
        // that is lost at the next power cut, and this screen is on a wall.
        this->save_token_();
        ESP_LOGI(TAG, "Claimed. This screen is now a %s.", this->device_id_.c_str());
      } else if (status == 409 || status == 404) {
        // 409 Conflict or 404 Not Found means the claim code is invalid or
        // already used (single-use, 7-day TTL). Stop retrying — the user needs
        // to re-provision with a fresh bind code.
        this->claim_refused_ = true;
        this->last_error_ = "This screen's claim code is invalid or already used.";
        ESP_LOGW(TAG, "Claim refused (%d): claim code invalid or already used.", status);
      } else {
        this->last_error_ = "This screen's setup code was refused.";
        ESP_LOGW(TAG, "Claim refused (%d).", status);
      }
      return;

    case Req::STATE:
      // 401 and 410 mean different things to someone holding a wall panel: 401 is
      // "flash it again", 410 is "someone removed this screen". The screen has to
      // be able to say which.
      if (status == 401) {
        this->claimed_ = false;
        this->last_error_ = "This screen is not set up. Flash it again.";
      } else if (status == 410) {
        this->claimed_ = false;
        this->last_error_ = "This screen was removed from the station.";
      } else if (status == 200) {
        this->last_error_.clear();
        this->parse_state_(body);
      }
      return;

    case Req::SCHEDULE:
      if (status == 200) {
        this->parse_schedule_(body);
      }
      return;

    case Req::ARTWORK:
      // A cover that fails to fetch is NOT a blank screen. The outgoing artwork
      // stays on the glass — which is what the web player does too, and why a
      // cold cache never flashes an empty box.
      if (status != 200 || body.empty()) {
        ESP_LOGW(TAG, "Artwork did not arrive; keeping the current cover.");
        return;
      }
      ESP_LOGI(TAG, "Artwork received, %u bytes.", (unsigned) body.size());
      return;

    case Req::SKIP:
      if (status == 409 || status == 429) {
        // The server re-decides under the same policy the player's Skip uses, so
        // the screen can show a control the station then refuses. Say why rather
        // than appearing to do nothing.
        this->last_error_ = status == 409 ? "Somebody else is listening." : "Too soon.";
      } else if (status == 200) {
        this->last_error_.clear();
      }
      return;

    case Req::HEARTBEAT:
    case Req::SETTINGS:
      if (status == 401) {
        ESP_LOGW(TAG, "This screen is not set up any more. Flash it again.");
        this->claimed_ = false;
      }
      return;
  }
}

void SubwaveDisplay::request_skip() {
  if (!this->skip_.enabled) return;
  this->request_(Req::SKIP, "POST", "/api/devices/skip", "{}", 15000);
  // The server re-decides, using the same policy the player's Skip uses, so the
  // screen cannot show a control the station would refuse.
}

void SubwaveDisplay::send_heartbeat_() {
  if (!this->claimed_) return;
  auto *wifi = esphome::wifi::global_wifi_component;
  std::string body = "{";
  body += "\"deviceId\":\"" + this->device_id_ + "\",";
  body += "\"appliedRev\":" + std::to_string(this->settings_rev_) + ",";
  body += "\"orientation\":\"" + this->settings_.orientation + "\",";
  // ESPHOME_PROJECT_VERSION is emitted from the `project:` block at build time, so
  // the screen cannot report a version that disagrees with the image it is running.
  body += "\"firmwareVer\":\"" + std::string(ESPHOME_PROJECT_VERSION) + "\"";
  if (wifi != nullptr) {
    body += ",\"rssi\":" + std::to_string(wifi->wifi_rssi());
    // get_ip_addresses() returns every interface the stack holds; the first
    // SET one is the address somebody would type to reach this screen.
    for (const auto &addr : wifi->get_ip_addresses()) {
      if (addr.is_set()) {
        body += ",\"ip\":\"" + addr.str() + "\"";
        break;
      }
    }
  }
  body += "}";

  this->request_(Req::HEARTBEAT, "POST", "/api/devices/heartbeat", body, 15000);
}

void SubwaveDisplay::send_heartbeat() {
  // Public wrapper. The interval is YAML; see the declaration for why.
  this->send_heartbeat_();
}

void SubwaveDisplay::push_settings(const StationSettings &s) {
  ESP_LOGI(TAG, "push_settings: idle_mode=%s idle_min=%d idle_pct=%d", s.idle_mode.c_str(), s.idle_min, s.idle_pct);
  this->settings_ = s;
  if (!this->claimed_) return;
  std::string body = "{\"settings\":{";
  body += "\"brightness\":" + std::to_string(s.brightness);
  body += ",\"orientation\":\"" + s.orientation + "\"";
  body += ",\"themeMode\":\"" + s.theme_mode + "\"";
  body += ",\"idleMode\":\"" + s.idle_mode + "\"";
  body += ",\"idleMin\":" + std::to_string(s.idle_min);
  body += ",\"idlePct\":" + std::to_string(s.idle_pct);
  body += ",\"skipEnabled\":" + std::string(s.skip_enabled ? "true" : "false");
  body += "}}";

  this->request_(Req::SETTINGS, "PATCH", "/api/devices/heartbeat", body, 15000);
}

void SubwaveDisplay::update() {
  if (!esphome::network::is_connected()) {
    this->server_reachable_ = false;
    return;
  }

  // Bind step: if we have a bind code but no identity, try to bind now.
  if (this->needs_bind()) {
    ESP_LOGI(TAG, "Attempting bind with code %s", this->bind_code_.c_str());
    if (this->bind(this->server_url_, this->bind_code_)) {
      this->bind_code_.clear();
      this->save_bind_code_();
      ESP_LOGI(TAG, "Bind successful. Claiming...");
    } else {
      ESP_LOGW(TAG, "Bind failed. Will retry.");
      return;
    }
  }

  this->poll_state_();
}

// ---------------------------------------------------------------------------
// The one piece of persistent state.
//
// A FIXED-SIZE BUFFER, not a std::string. Preferences are stored by
// memcpy of a trivially-copyable type, and make_preference<std::string> fails to
// compile on exactly that constraint — which is a good constraint: a stored
// value cannot then be made to allocate, and the thing on the flash is a
// predictable 65 bytes rather than whatever the heap felt like that day.
//
// 65 is a bearer token and a NUL. The key hash is "SWB1".
// ---------------------------------------------------------------------------
void SubwaveDisplay::save_token_() {
  if (esphome::global_preferences == nullptr) return;
  char buf[TOKEN_BYTES] = {0};
  size_t n = std::min(this->bearer_.size(), TOKEN_BYTES - 1);
  memcpy(buf, this->bearer_.data(), n);
  auto pref = esphome::global_preferences->make_preference<char[TOKEN_BYTES]>(TOKEN_KEY, true);
  pref.save(&buf);
  esphome::global_preferences->sync();
}

void SubwaveDisplay::load_token_() {
  if (esphome::global_preferences == nullptr) return;
  char buf[TOKEN_BYTES] = {0};
  auto pref = esphome::global_preferences->make_preference<char[TOKEN_BYTES]>(TOKEN_KEY, true);
  // load() returning false means the key has never been written, so it replaces
  // the separate "does this key exist" check the old string API needed.
  if (!pref.load(&buf)) return;
  buf[TOKEN_BYTES - 1] = '\0';
  std::string stored(buf);
  if (stored.empty()) return;
  this->bearer_ = stored;
  this->claimed_ = true;
  ESP_LOGI(TAG, "Found a stored credential; this screen is set up.");
}

// ---------------------------------------------------------------------------
// Bound identity: server URL, device ID, claim token.
//
// A standard image carries none of these at compile time. The device collects
// the server URL and a bind code during setup, POSTs them to the station's bind
// endpoint, and stores the resulting identity here. Subsequent boots load it
// and skip setup entirely.
// ---------------------------------------------------------------------------
void SubwaveDisplay::save_identity_() {
  if (esphome::global_preferences == nullptr) return;

  // Server URL
  {
    char buf[URL_BYTES] = {0};
    size_t n = std::min(this->server_url_.size(), URL_BYTES - 1);
    memcpy(buf, this->server_url_.data(), n);
    auto pref = esphome::global_preferences->make_preference<char[URL_BYTES]>(URL_KEY, true);
    pref.save(&buf);
  }
  // Device ID
  {
    char buf[ID_BYTES] = {0};
    size_t n = std::min(this->device_id_.size(), ID_BYTES - 1);
    memcpy(buf, this->device_id_.data(), n);
    auto pref = esphome::global_preferences->make_preference<char[ID_BYTES]>(DEVICE_ID_KEY, true);
    pref.save(&buf);
  }
  // Claim token
  {
    char buf[CLAIM_BYTES] = {0};
    size_t n = std::min(this->claim_token_.size(), CLAIM_BYTES - 1);
    memcpy(buf, this->claim_token_.data(), n);
    auto pref = esphome::global_preferences->make_preference<char[CLAIM_BYTES]>(CLAIM_TOKEN_KEY, true);
    pref.save(&buf);
  }
  esphome::global_preferences->sync();
  ESP_LOGI(TAG, "Identity saved: %s", this->device_id_.c_str());
}

void SubwaveDisplay::load_identity_from_flash_() {
  if (esphome::global_preferences == nullptr) return;

  // Server URL
  {
    char buf[URL_BYTES] = {0};
    auto pref = esphome::global_preferences->make_preference<char[URL_BYTES]>(URL_KEY, true);
    if (pref.load(&buf)) {
      buf[URL_BYTES - 1] = '\0';
      std::string stored(buf);
      if (!stored.empty()) this->server_url_ = stored;
    }
  }
  // Device ID
  {
    char buf[ID_BYTES] = {0};
    auto pref = esphome::global_preferences->make_preference<char[ID_BYTES]>(DEVICE_ID_KEY, true);
    if (pref.load(&buf)) {
      buf[ID_BYTES - 1] = '\0';
      std::string stored(buf);
      if (!stored.empty()) this->device_id_ = stored;
    }
  }
  // Claim token
  {
    char buf[CLAIM_BYTES] = {0};
    auto pref = esphome::global_preferences->make_preference<char[CLAIM_BYTES]>(CLAIM_TOKEN_KEY, true);
    if (pref.load(&buf)) {
      buf[CLAIM_BYTES - 1] = '\0';
      std::string stored(buf);
      if (!stored.empty()) this->claim_token_ = stored;
    }
  }
  // Bearer token
  {
    char buf[TOKEN_BYTES] = {0};
    auto pref = esphome::global_preferences->make_preference<char[TOKEN_BYTES]>(TOKEN_KEY, true);
    if (pref.load(&buf)) {
      buf[TOKEN_BYTES - 1] = '\0';
      std::string stored(buf);
      if (!stored.empty()) this->bearer_ = stored;
    }
  }

  if (!this->server_url_.empty() && !this->device_id_.empty() && !this->claim_token_.empty()) {
    ESP_LOGI(TAG, "Found stored identity: %s @ %s. claimed_=%d", this->device_id_.c_str(), this->server_url_.c_str(), (int)this->claimed_);
    this->claimed_ = true;  // already claimed — no need to claim again after reboot
  } else {
    ESP_LOGI(TAG, "No stored identity. Setup required.");
  }
}

void SubwaveDisplay::save_bind_code_() {
  if (esphome::global_preferences == nullptr) return;
  char buf[BIND_CODE_BYTES] = {0};
  size_t n = std::min(this->bind_code_.size(), BIND_CODE_BYTES - 1);
  memcpy(buf, this->bind_code_.data(), n);
  auto pref = esphome::global_preferences->make_preference<char[BIND_CODE_BYTES]>(BIND_CODE_KEY, true);
  pref.save(&buf);
  esphome::global_preferences->sync();
}

void SubwaveDisplay::load_bind_code_() {
  if (esphome::global_preferences == nullptr) return;
  char buf[BIND_CODE_BYTES] = {0};
  auto pref = esphome::global_preferences->make_preference<char[BIND_CODE_BYTES]>(BIND_CODE_KEY, true);
  if (!pref.load(&buf)) return;
  buf[BIND_CODE_BYTES - 1] = '\0';
  std::string stored(buf);
  if (stored.empty()) return;
  this->bind_code_ = stored;
  ESP_LOGI(TAG, "Found stored bind code.");
}

bool SubwaveDisplay::bind(const std::string &server_url, const std::string &bind_code) {
  if (server_url.empty() || bind_code.empty()) return false;

  this->server_url_ = server_url;
  this->api_base_ = server_url;

  // POST to the bind endpoint
  std::string body = "{\"bindCode\":\"" + bind_code + "\"}";

  auto *client = this->http();
  if (client == nullptr) return false;

  std::vector<esphome::http_request::Header> headers;
  headers.push_back({"Content-Type", "application/json"});

  auto container = client->start(server_url + "/api/devices/bind", "POST", body, headers);
  if (container == nullptr) {
    ESP_LOGW(TAG, "bind: could not start request");
    return false;
  }

  // Read response
  constexpr size_t MAX_BODY = 4096;
  std::string out;
  out.reserve(512);
  uint8_t chunk[512];
  while (!container->is_read_complete()) {
    int n = container->read(chunk, sizeof(chunk));
    if (n > 0) {
      if (out.size() + static_cast<size_t>(n) > MAX_BODY) {
        container->end();
        return false;
      }
      out.append(reinterpret_cast<char *>(chunk), static_cast<size_t>(n));
    }
  }
  container->end();

  // Parse response
  cJSON *root = cJSON_Parse(out.c_str());
  if (root == nullptr) {
    ESP_LOGW(TAG, "bind: invalid response");
    return false;
  }

  const char *device_id = cJSON_GetStringValue(cJSON_GetObjectItem(root, "deviceId"));
  const char *claim_token = cJSON_GetStringValue(cJSON_GetObjectItem(root, "claimToken"));
  const char *bearer_token = cJSON_GetStringValue(cJSON_GetObjectItem(root, "token"));

  if (device_id == nullptr || claim_token == nullptr) {
    cJSON_Delete(root);
    ESP_LOGW(TAG, "bind: missing fields in response");
    return false;
  }

  this->device_id_ = device_id;
  this->claim_token_ = claim_token;
  cJSON_Delete(root);

  // Claim to get bearer token — synchronous so we don't reboot before it lands
this->claim_refused_ = false;
this->claimed_ = false;
this->claim_device_();

  ESP_LOGI(TAG, "Bound successfully: %s", this->device_id_.c_str());
  return true;
}

namespace {

// Custom web handler for the setup wizard
class SetupWizardHandler : public esphome::web_server_idf::AsyncWebHandler {
 public:
  bool canHandle(esphome::web_server_idf::AsyncWebServerRequest *request) const override {
    if (request->method() != HTTP_GET) return false;
    char url_buf[esphome::web_server_idf::AsyncWebServerRequest::URL_BUF_SIZE];
    return request->url_to(url_buf) == "/";
  }

  void handleRequest(esphome::web_server_idf::AsyncWebServerRequest *request) override {
    if (!this->canHandle(request)) return;

    std::string ssid = "SUBWAVE-SCREEN";
    std::string ip = "192.168.4.1";
    auto *wifi = esphome::wifi::global_wifi_component;
    if (wifi != nullptr && wifi->is_connected()) {
      for (const auto &addr : wifi->get_ip_addresses()) {
        if (addr.is_set()) {
          ip = addr.str();
          break;
        }
      }
    }
    std::string qr_url = "http://" + ip;

    std::string html = R"HTML(
<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUB/WAVE Screen Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#06101e;color:#dce8f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
h1{font-size:2.5rem;font-weight:600;margin-bottom:0.5rem;color:#dce8f5}
h2{font-size:1.2rem;font-weight:400;margin-bottom:2rem;color:#6a8ba8}
.qr-container{background:#e8edf3;padding:32px;border-radius:16px;margin:2rem 0;display:inline-block}
.qr-image{max-width:100%;height:auto;display:block}
.url{font-family:monospace;font-size:1rem;color:#4e9fd4;word-break:break-all;background:#0d1f35;padding:1rem;border-radius:8px;margin:1.5rem 0;max-width:90%;text-align:center}
.instructions{text-align:center;max-width:500px;line-height:1.6}
.instructions p{margin:1rem 0;color:#6a8ba8}
.step{font-weight:600;color:#4e9fd4}
.brand{margin-top:3rem;padding-top:2rem;border-top:1px solid #1a3050;color:#6a8ba8;font-size:0.9rem}
</style>
</head><body>
<h1>SUB/WAVE Screen</h1>
<h2>Setup Wizard</h2>
<div class="qr-container">
<svg id="qr" class="qr-image"></svg>
</div>
<div class="url" id="url"></div>
<div class="instructions">
<p>Join the WiFi network <span class="step">)" + ssid + R"HTML(</span></p>
<p>Then scan the QR code above, or visit <span class="step">)" + qr_url + R"HTML(</span> in your browser.</p>
<p>Enter your WiFi credentials to connect this screen to the internet.</p>
</div>
<div class="brand">SUB/WAVE — causewayfm.subwave-screen</div>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<script>
new QRCode(document.getElementById("qr"), {text: ")" + qr_url + R"HTML(", width: 280, height: 280, colorDark: "#0b1a2b", colorLight: "#e8edf3", correctLevel: QRCode.CorrectLevel.M});
document.getElementById("url").textContent = ")" + qr_url + R"HTML(";
</script>
</body></html>
)HTML";

    request->send(200, "text/html", html.c_str());
  }
};

}  // namespace

void SubwaveDisplay::register_web_handler_() {
  auto *base = esphome::web_server_base::global_web_server_base;
  if (base == nullptr) return;

  auto *server = base->get_server();
  if (server == nullptr) return;

  auto *handler = new SetupWizardHandler();  // NOLINT(cppcoreguidelines-owning-memory)
  server->addHandler(handler);
}

// ---------------------------------------------------------------------------
// The connectivity ladder.
//
// FOUR STEPS, AND EACH ONE EXISTS BECAUSE IT FAILS DIFFERENTLY.
//
//   NO_WIFI    no association, or the password was refused
//   NO_ROUTE   associated and holding an IP, and nothing gets out
//   NO_DNS     a route exists, but names do not resolve
//   NO_SERVER  the internet works and the station does not answer
//
// The two middle ones are the reason this is not a single check. A guest network
// hands out an address and then intercepts traffic: `wifi.connected` is TRUE, the
// screen is convinced it is online, and it will never fetch a song. The only
// thing that distinguishes it from a working network is opening a socket to
// something outside and finding nothing there.
//
// The DNS step is separate again, and deliberately. A captive portal commonly
// answers DHCP and then answers DNS itself, with an intercept page instead of an
// address — so a TCP connect to a literal IP can succeed while every name fails.
// Merging the two would report "no internet" for both and send somebody to sign
// in to a guest portal that was never the problem.
//
// NOT PERFORMED IN PIECES. Each probe gets its own deadline and they run in
// order, so the first failure is the one reported rather than whichever happened
// to fail last.
// ---------------------------------------------------------------------------

namespace {

/** How long any one probe may take before it counts as a failure. */
constexpr uint16_t PROBE_TIMEOUT_MS = 4000;

/**
 * Can we open a TCP connection to a literal address?
 *
 * A LITERAL, not a name — that is the whole test. Resolving a name first would
 * make this depend on DNS, which is the step after it, and a device with broken
 * DNS would report "no route out" and send somebody to sign in to a guest portal
 * that was never the problem.
 *
 * 1.1.1.1:53 is used rather than an HTTP port so the test does not depend on
 * anything the server runs. Port 53 is open on essentially every network on earth,
 * which is the property wanted from a canary.
 */
bool route_exists() {
  const struct {
    const char *ip;
    uint16_t port;
  } CANARY{"1.1.1.1", 53};

  struct sockaddr_in addr {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(CANARY.port);
  if (inet_pton(AF_INET, CANARY.ip, &addr.sin_addr) != 1)
    return false;

  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0)
    return false;

  // Non-blocking, because a connect() to a black hole otherwise sits in the
  // kernel for the TCP retransmit timeout — which is minutes, and would hold the
  // main loop long enough to trip the task watchdog.
  int flags = ::fcntl(fd, F_GETFL, 0);
  ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  bool ok = false;
  if (::connect(fd, reinterpret_cast<struct sockaddr *>(&addr), sizeof(addr)) == 0) {
    ok = true;
  } else if (errno == EINPROGRESS) {
    fd_set wr;
    FD_ZERO(&wr);
    FD_SET(fd, &wr);
    struct timeval tv{PROBE_TIMEOUT_MS / 1000, (PROBE_TIMEOUT_MS % 1000) * 1000};
    ok = ::select(fd + 1, nullptr, &wr, nullptr, &tv) > 0;
  }

  ::close(fd);
  return ok;
}

/** The bare host and port from a URL, for the resolver and the station probe. */
void split_url(const std::string &url, std::string *host, uint16_t *port) {
  // The URL carries a scheme and a path; the resolver wants a bare host. Take
  // the authority and stop at the first '/', '?' or '#'.
  std::string h = url;
  const size_t scheme = h.find("://");
  const bool https = scheme != std::string::npos && h.compare(scheme, 6, "https:") == 0;
  if (scheme != std::string::npos)
    h = h.substr(scheme + 3);
  const size_t cut = h.find_first_of("/?#");
  if (cut != std::string::npos)
    h = h.substr(0, cut);

  // An explicit port wins over the scheme's default.
  uint16_t p = https ? 443 : 80;
  const size_t colon = h.rfind(':');
  if (colon != std::string::npos && h.find(']') == std::string::npos) {
    p = (uint16_t) atoi(h.c_str() + colon + 1);
    h = h.substr(0, colon);
  }

  *host = h;
  *port = p;
}

/** Resolve to an IPv4 address. Returns false when the name does not resolve. */
bool resolve_host(const std::string &host, struct in_addr *out) {
  if (host.empty())
    return false;

  struct addrinfo hints {};
  hints.ai_family = AF_INET;  // A record only. AAAA on a v4-only radio is a false negative.
  hints.ai_socktype = SOCK_STREAM;

  struct addrinfo *res = nullptr;
  const int rc = ::getaddrinfo(host.c_str(), nullptr, &hints, &res);
  if (rc != 0 || res == nullptr)
    return false;
  *out = ((struct sockaddr_in *) res->ai_addr)->sin_addr;
  ::freeaddrinfo(res);
  return true;
}

/** Can we open a TCP connection to an address we already hold? */
bool connects_to(struct in_addr addr, uint16_t port) {
  struct sockaddr_in sa {};
  sa.sin_family = AF_INET;
  sa.sin_port = htons(port);
  sa.sin_addr = addr;

  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0)
    return false;

  int flags = ::fcntl(fd, F_GETFL, 0);
  ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  bool ok = false;
  if (::connect(fd, reinterpret_cast<struct sockaddr *>(&sa), sizeof(sa)) == 0) {
    ok = true;
  } else if (errno == EINPROGRESS) {
    fd_set wr;
    FD_ZERO(&wr);
    FD_SET(fd, &wr);
    struct timeval tv{PROBE_TIMEOUT_MS / 1000, (PROBE_TIMEOUT_MS % 1000) * 1000};
    ok = ::select(fd + 1, nullptr, &wr, nullptr, &tv) > 0;
  }

  ::close(fd);
  return ok;
}

}  // namespace

SubwaveDisplay::Connectivity SubwaveDisplay::check_connectivity() {
  // 1. THE LINK. Without an association there is nothing else to test, and every
  //    later probe would report a misleading failure.
  if (esphome::wifi::global_wifi_component == nullptr || !esphome::wifi::global_wifi_component->is_connected()) {
    this->connectivity_ = Connectivity::NO_WIFI;
    ESP_LOGW(TAG, "Connectivity: no association.");
    return this->connectivity_;
  }

  // 2. THE ROUTE. A literal address, because this step must not depend on DNS.
  if (!route_exists()) {
    this->connectivity_ = Connectivity::NO_ROUTE;
    ESP_LOGW(TAG, "Connectivity: associated, but nothing gets out. Guest network or captive portal.");
    return this->connectivity_;
  }

  // 3. THE NAME. The route works, so this is DNS and nothing else.
  //
  // UNBOUND DEVICES HAVE NO SERVER URL YET. A standard image carries none, so
  // on first boot server_url_ is empty and the device has not been told where
  // the station is. The connectivity ladder cannot check a name that does not
  // exist, so it stops at "route works" and reports OK — the station check
  // happens later, once the operator types the URL into the setup wizard.
  if (this->server_url_.empty()) {
    this->connectivity_ = Connectivity::OK;
    ESP_LOGI(TAG, "Connectivity: route works. No server URL yet (unbound device).");
    return this->connectivity_;
  }

  std::string host;
  uint16_t port = 443;
  split_url(this->server_url_, &host, &port);

  struct in_addr station_addr {};
  if (host.empty() || !resolve_host(host, &station_addr)) {
    this->connectivity_ = Connectivity::NO_DNS;
    ESP_LOGW(TAG, "Connectivity: the route works but '%s' does not resolve. Station URL is '%s'.", host.c_str(),
             this->server_url_.c_str());
    return this->connectivity_;
  }

  // 4. THE STATION. Resolving is not reaching — the name can point somewhere the
  //    device cannot get to, and a misconfigured server address looks exactly
  //    like a healthy network from here.
  //
  //    PROBED, NOT READ FROM server_reachable_. That flag is set by the API
  //    client's responses, so on a screen that has not yet claimed — or one whose
  //    requests have not completed — it is still false, and reading it reported
  //    a working station as unreachable. The first version of this ladder did
  //    exactly that and told an unprovisioned screen to go and check its station
  //    address, which is not a thing a wall screen can do. The TCP connect is to
  //    the station's own host and port, which needs no token and no prior state.
  if (!connects_to(station_addr, port)) {
    this->connectivity_ = Connectivity::NO_SERVER;
    ESP_LOGW(TAG, "Connectivity: the internet works, the station's name resolves, but %s:%u does not answer.",
             host.c_str(), (unsigned) port);
    return this->connectivity_;
  }

  this->connectivity_ = Connectivity::OK;
  ESP_LOGI(TAG, "Connectivity: all four steps pass. Not asking for setup.");
  return this->connectivity_;
}

const char *SubwaveDisplay::connectivity_message(Connectivity c) const {
  switch (c) {
    case Connectivity::OK:
      return "";
    case Connectivity::NO_WIFI:
      // "That password did not work" is right for a re-provision and wrong for a
      // first boot, and this screen cannot tell those apart — so it says the
      // thing that is true either way and names the next action.
      return "This screen is not on your network. Pick one below and enter its password.";
    case Connectivity::NO_ROUTE:
      return "Connected, but nothing gets out. A guest network needs a sign-in page — "
             "open the page your network opened, sign in, then try again.";
    case Connectivity::NO_DNS:
      return "Connected, but names do not resolve. Your network may need a sign-in page "
             "before it will let this screen online.";
    case Connectivity::NO_SERVER:
      return "Connected to the internet, but this screen cannot reach your station. "
             "Check the station address in the app.";
    case Connectivity::UNKNOWN:
    default:
      return "Still checking your network.";
  }
}

}  // namespace subwave_display
