#include "display_client.h"

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
  this->api_base_ = this->server_url_;

  // The token lives in flash and nowhere else. The device's entire persistent
  // state is these credentials plus the WiFi ones — settings, schedule, branding
  // and artwork are all re-fetched from the server on demand, which is why a
  // factory reset costs nothing but a re-flash.
  if (esphome::global_preferences != nullptr) {
    this->load_token_();
  }

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
  if (this->claimed_ || this->claim_token_ == "unprovisioned") return this->claimed_;

  std::string body = "{";
  body += "\"deviceId\":\"" + this->device_id_ + "\",";
  body += "\"claimToken\":\"" + this->claim_token_ + "\",";
  // The timezone is NOT sent here. The setup portal asks the browser for it and
  // the station keeps it against the device row, so the screen never holds a
  // clock it would have to trust — an earlier version of this file fetched the
  // wifi interface here and sent an empty string either way, which looked like
  // telemetry and was a no-op.
  body += ",\"timezone\":\"\"";
  body += "}";

  this->request_(Req::CLAIM, "POST", "/api/devices/claim", body, 15000);

  // The response is handled by the caller's next poll: this is fire and forget,
  // because a claim that has not landed yet is not an error worth blocking on.
  return false;
}

void SubwaveDisplay::poll_state_() {
  if (!this->claimed_) {
    this->claim_device_();
    return;
  }

  this->request_(Req::STATE, "GET", "/api/devices/state", "", 12000);
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
    this->settings_.brightness = int_at(theme, "brightness", this->settings_.brightness);
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
        this->claimed_ = true;
        // Persist immediately. A claim that is not written to flash is a claim
        // that is lost at the next power cut, and this screen is on a wall.
        this->save_token_();
        ESP_LOGI(TAG, "Claimed. This screen is now a %s.", this->device_id_.c_str());
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

void SubwaveDisplay::request_artwork(const std::string &url) {
  if (url.empty()) return;
  // An absolute URL is passed through untouched; the artwork route is proxied
  // under the app's own host and the server sends a path, never a foreign URL.
  if (url[0] == '/') {
    this->request_(Req::ARTWORK, "GET", url, "", 15000);
  } else {
    this->request_(Req::ARTWORK, "GET", "", url, 15000);
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

void SubwaveDisplay::push_settings(const StationSettings &s) {
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

void SubwaveDisplay::poll_schedule_() { /* fetched when the shows window opens */ }

void SubwaveDisplay::update() {
  if (!esphome::network::is_connected()) {
    this->server_reachable_ = false;
    return;
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

void SubwaveDisplay::acknowledge_rotation() {
  // A rotated token arrives in a heartbeat response and is written straight over
  // the top. Nothing else needs to happen: the server clears its grace hash in the
  // same write, so the old credential dies the moment the new one lands.
  if (this->bearer_.empty()) return;
  this->save_token_();
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

}  // namespace subwave_display