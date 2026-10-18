#include "setup_web.h"

#include <cstring>

#include "esphome/core/application.h"
#include "esphome/core/log.h"
#include "esphome/core/scheduler.h"
#include "esphome/components/wifi/wifi_component.h"
#include "esphome/core/preferences.h"

// The IDF WiFi API, for log_radio_state(). Not reachable from a YAML lambda:
// main.cpp includes esphome.h, which brings in the wifi COMPONENT's headers
// but not esp_wifi.h itself.
#include <esp_wifi.h>

namespace esphome::subwave_setup_web {

static const char *const TAG = "subwave.setup";

// Captive-portal DETECTION endpoints. Phones hit these the moment they join a
// network, expecting a specific non-2xx or a specific body; answering with the
// wizard is what makes the "Sign in to Wi-Fi?" sheet appear at all.
//
// This is the part that is easy to miss. A wizard at "/" that nobody is
// navigated to is a wizard nobody ever sees — the phone never opens a browser
// unless the network first fails to convince it that it is already online.
static const char *const CAPTIVE_PROBE_PATHS[] = {
    "/generate_204",     // Android
    "/gen_204",          // Android, alternate
    "/hotspot-detect.html",  // iOS/macOS
    "/connecttest.txt",  // Windows
    "/ncsi.txt",         // Windows
    "/success.txt",      // various
    "/redirect",         // Android, carries ?url=
};

static bool is_captive_probe(const char *url) {
  for (const char *probe : CAPTIVE_PROBE_PATHS) {
    if (strcmp(url, probe) == 0)
      return true;
  }
  return false;
}

bool SetupWebHandler::canHandle(AsyncWebServerRequest *request) const {
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  const char *url = request->url_to(url_buf).c_str();

  if (request->method() == HTTP_POST)
    return strcmp(url, "/save") == 0;

  if (request->method() != HTTP_GET)
    return false;

  return strcmp(url, "/") == 0 || strcmp(url, "/scan") == 0 || is_captive_probe(url);
}

void SetupWebHandler::handleRequest(AsyncWebServerRequest *request) {
  char url_buf[AsyncWebServerRequest::URL_BUF_SIZE];
  const char *url = request->url_to(url_buf).c_str();

  if (strcmp(url, "/scan") == 0) {
    this->send_scan_(request);
    return;
  }
  if (strcmp(url, "/save") == 0) {
    this->save_(request);
    return;
  }
  this->send_wizard_(request);
}

void SetupWebHandler::send_scan_(AsyncWebServerRequest *request) {
  std::string body = "{\"station\":\"" + this->station_name_ + "\",\"ap\":\"" + this->ap_ssid_ + "\",\"aps\":[";

  auto *wifi = wifi::global_wifi_component;
  bool first = true;
  if (wifi != nullptr) {
    // NO SCAN FROM HERE. Deliberately, and now for a different reason than it
    // used to be.
    //
    // This used to say "the boot-time scan will fill the list soon enough", and
    // that was wrong: the scan ESPHome runs during wifi setup does not finish on
    // this device, so it never fills anything. The scan is now kicked explicitly
    // by the on-screen script (and by request_scan()), which is a deliberate
    // action rather than a side effect of a phone loading a page.
    //
    // Kicking one from here would mean every eight-second poll from every phone
    // on the access point restarts the radio's scan, so the list would never
    // settle on a stable answer — and two phones opening the wizard would fight
    // over the radio.

    for (const auto &scan : wifi->get_scan_result()) {
      if (scan.get_is_hidden())
        continue;
      // The stock portal hand-rolls JSON escaping too. An SSID containing a
      // quote produces a response the phone's parser rejects and the list
      // silently comes back empty, which is indistinguishable from "no wifi".
      std::string ssid = scan.get_ssid().c_str();
      std::string esc;
      esc.reserve(ssid.size() + 8);
      for (char c : ssid) {
        if (c == '"' || c == '\\') {
          esc += '\\';
          esc += c;
        } else if ((unsigned char) c < 0x20) {
          esc += ' ';
        } else {
          esc += c;
        }
      }
      if (!first)
        body += ',';
      first = false;
      body += "{\"ssid\":\"" + esc + "\",\"rssi\":" + std::to_string(scan.get_rssi()) +
              ",\"lock\":" + std::to_string(scan.get_with_auth() ? 1 : 0) + "}";
    }
  }
  body += "]}";

  request->send(200, "application/json", body.c_str());
}

void SetupWebHandler::save_(AsyncWebServerRequest *request) {
  std::string ssid = request->arg("ssid");
  std::string psk = request->arg("psk");
  std::string tz = request->arg("tz");
  std::string lat = request->arg("lat");
  std::string lon = request->arg("lon");
  std::string server_url = request->arg("server_url");
  std::string bind_code = request->arg("bind_code");

  if (ssid.empty()) {
    ESP_LOGW(TAG, "save: rejected, no ssid");
    request->send(400, "text/plain", "No network selected.");
    return;
  }

  // Timezone and coordinates are asked here rather than guessed, but the
  // timezone is captured from the BROWSER, not the device: a phone that joined
  // the access point knows where it is standing far better than a screen with
  // no RTC, no cell and no GNSS. Logged for now; persisting them is the next
  // step and needs a preferences key, not another log line.
  ESP_LOGI(TAG, "Requested WiFi settings change:");
  ESP_LOGI(TAG, "  SSID='%s'", ssid.c_str());
  ESP_LOGI(TAG, "  Password='%s'", psk.c_str());
  ESP_LOGI(TAG, "  Timezone='%s'  Lat='%s'  Lon='%s'", tz.c_str(), lat.c_str(), lon.c_str());

  auto *wifi = wifi::global_wifi_component;
  if (wifi == nullptr) {
    request->send(500, "text/plain", "WiFi is not available.");
    return;
  }

  // Deferred, not called inline: save_wifi_sta writes NVS and this runs on the
  // HTTP task. ESPHome's own captive portal defers for exactly the same reason.
  //
  // `App.scheduler.set_timeout` rather than `Component::defer` because this
  // handler is not a Component — it is only an AsyncWebHandler that happens to
  // be owned by one.
  App.scheduler.set_timeout(this, 0, [ssid, psk, server_url, bind_code]() {
    if (wifi::global_wifi_component != nullptr)
      wifi::global_wifi_component->save_wifi_sta(ssid.c_str(), psk.c_str());

    // Store the server URL and bind code in flash so the device can bind
    // after it reboots with WiFi connected.
    if (esphome::global_preferences != nullptr) {
      if (!server_url.empty()) {
        char buf[256] = {0};
        size_t n = std::min(server_url.size(), (size_t)255);
        memcpy(buf, server_url.data(), n);
        auto pref = esphome::global_preferences->make_preference<char[256]>(0x53574232, true);  // "SWB2"
        pref.save(&buf);
      }
      if (!bind_code.empty()) {
        char buf[16] = {0};
        size_t n = std::min(bind_code.size(), (size_t)15);
        memcpy(buf, bind_code.data(), n);
        auto pref = esphome::global_preferences->make_preference<char[16]>(0x53574235, true);  // "SWB5"
        pref.save(&buf);
      }
      esphome::global_preferences->sync();
    }
  });

  request->send(200, "text/plain", "Saved. Connecting...");
}

void SetupWebHandler::send_wizard_(AsyncWebServerRequest *request) {
  // Everything inline. No CDN, no webfonts, no external anything: this page is
  // served by a screen that may be the only thing on a guest network, and a
  // wizard that renders blank because a CDN was unreachable is a wizard that
  // bricks the install.
  const std::string name = this->station_name_;
  const std::string ap = this->ap_ssid_;

  std::string html = R"HTML(<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>)HTML";
  html += name;
  html += R"HTML( Screen — Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#dce8f5; --dim:#6a8ba8; --bg:#06101e; --panel:#0d1f35;
  --line:#1a3050; --brass:#c8a76a; --link:#4e9fd4;
}
html,body{height:100%}
body{
  background:var(--bg); color:var(--ink); min-height:100%;
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  display:flex; flex-direction:column; align-items:center; padding:32px 18px 48px;
}
.wrap{width:100%;max-width:560px}
header{margin-bottom:24px}
h1{font-size:1.75rem;font-weight:600;letter-spacing:-.01em}
h1 .sub{color:var(--brass)}
.subtitle{color:var(--dim);margin-top:2px}
ol{list-style:none;counter-reset:step}
li{counter-increment:step;margin-bottom:14px}
li::before{
  content:counter(step); display:inline-flex; align-items:center; justify-content:center;
  width:22px;height:22px;border-radius:50%;background:var(--panel);border:1px solid var(--line);
  color:var(--brass);font-size:12px;font-weight:600;margin-right:8px;vertical-align:2px;
}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
label{display:block;font-size:13px;color:var(--dim);margin-bottom:6px}
input{
  width:100%;padding:11px 12px;background:#081627;border:1px solid var(--line);
  border-radius:9px;color:var(--ink);font:inherit;
}
input:focus{outline:none;border-color:var(--link)}
select{width:100%;padding:11px 12px;background:#081627;border:1px solid var(--line);border-radius:9px;color:var(--ink);font:inherit}
.hint{font-size:12px;color:var(--dim);margin-top:6px}
.row{display:flex;gap:10px}
.row>*{flex:1}
button{
  width:100%;margin-top:18px;padding:14px;border:0;border-radius:11px;
  background:var(--brass);color:#06101e;font:600 16px/1 inherit;cursor:pointer;
}
button:disabled{opacity:.45;cursor:default}
#status{margin-top:14px;padding:12px 14px;border-radius:10px;font-size:14px;display:none}
#status.ok{display:block;background:#0e2a1c;border:1px solid #1d5c3c;color:#8fe0b0}
#status.err{display:block;background:#2a0e14;border:1px solid #5c1d2a;color:#f0a8b4}
#status.busy{display:block;background:var(--panel);border:1px solid var(--line);color:var(--dim)}
.netlist{max-height:210px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:#081627}
.net{display:flex;align-items:center;gap:10px;padding:11px 12px;border-bottom:1px solid #12243c;cursor:pointer}
.net:last-child{border-bottom:0}
.net:active{background:#0f2540}
.net.sel{background:#12304f}
.net .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.net .lock{color:var(--dim);font-size:12px}
.net .sig{font-size:12px;color:var(--dim);width:42px;text-align:right}
.dot{width:8px;height:8px;border-radius:50%;background:#2a4a66;flex:none}
.dot.g{background:#3fae72}.dot.y{background:#c8a76a}
footer{margin-top:26px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px;text-align:center}
</style></head><body><div class="wrap">
<header>
  <h1><span class="sub">SUB/WAVE</span> Screen</h1>
  <div class="subtitle">Setup — this screen is not on the station yet.</div>
</header>
<form id="f" autocomplete="off">
<ol>
  <li><div class="card">
    <label for="ap">Join this network first</label>
    <div class="hint" style="margin-bottom:10px">Scan the QR code on the screen to join <strong id="apssid" style="color:var(--ink)">)HTML";
  html += ap;
  html += R"HTML(</strong>. WiFi password is shown on the screen's QR code.
    <div class="hint">Once joined, this page appears automatically. Pick your home network below.</div>
    <div id="sta" class="hint">Reading the browser's time zone…</div>
  </div></li>

  <li><div class="card">
    <label for="ssid">Home network</label>
    <div class="netlist" id="netlist"><div class="net"><span class="nm">Scanning…</span></div></div>
    <div class="hint" id="nethint">Pick the network this screen should stay on.</div>
    <div class="row" style="margin-top:12px">
      <div><label for="psk">Password</label><input id="psk" type="password" placeholder="Network password"></div>
    </div>
  </div></li>

  <li><div class="card">
    <label>Where this screen is</label>
    <div class="row">
      <div><label for="lat">Latitude</label><input id="lat" type="number" step="0.0001" placeholder="50.9097" value=")HTML";
  html += R"HTML("></div>
      <div><label for="lon">Longitude</label><input id="lon" type="number" step="0.0001" placeholder="-1.4044" value=")HTML";
  html += R"HTML("></div>
    </div>
    <div class="hint">Used for sunrise and sunset, so the screen's night mode matches the room. Change it later in the screen's own settings.</div>
  </div></li>

  <li><div class="card">
    <label for="server_url">Server address</label>
    <input id="server_url" type="url" placeholder="https://your-station.example.com" style="margin-bottom:12px">
    <div class="hint" style="margin-bottom:12px">The address of your SUB/WAVE station. The screen will fetch its identity from here.</div>
    <label for="bind_code">Bind code</label>
    <input id="bind_code" type="text" placeholder="AB1-C23" style="text-transform:uppercase;letter-spacing:0.15em;font-weight:bold;text-align:center">
    <div class="hint">The code shown on the admin panel when you created this screen. Single-use.</div>
  </div></li>
</ol>
<button id="go" type="submit">Connect this screen</button>
<div id="status"></div>
</form>
<footer>SUB/WAVE — causewayfm.subwave-screen</footer>
</div>
<script>
var tz = "";
try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
var tzEl = document.getElementById("sta");
tzEl.textContent = tz ? ("Time zone: " + tz) : "Time zone not reported by this browser — fill it in below.";
if (!tz) { tzEl.innerHTML += ' <input id="tz" placeholder="Europe/London" style="margin-top:8px">'; }

var picked = null;
function sig(d){ return d>= -60 ? "g" : (d>= -80 ? "y" : ""); }

function render(aps){
  var box = document.getElementById("netlist");
  box.innerHTML = "";
  if (!aps.length) {
    box.innerHTML = '<div class="net"><span class="nm">No networks found yet.</span></div>';
    return;
  }
  aps.forEach(function(a){
    var el = document.createElement("div");
    el.className = "net";
    el.innerHTML =
      '<span class="dot ' + sig(a.rssi) + '"></span>' +
      '<span class="nm"></span>' +
      '<span class="lock">' + (a.lock ? "&#128274;" : "") + '</span>' +
      '<span class="sig">' + a.rssi + "</span>";
    el.querySelector(".nm").textContent = a.ssid;
    el.onclick = function(){
      picked = a.ssid;
      [].forEach.call(box.children, function(c){ c.classList.remove("sel"); });
      el.classList.add("sel");
      document.getElementById("psk").focus();
    };
    box.appendChild(el);
  });
}

function scan(){
  fetch("/scan", {cache:"no-store"}).then(function(r){ return r.json(); }).then(function(j){
    var aps = (j.aps || []).slice().sort(function(a,b){ return b.rssi - a.rssi; });
    render(aps);
  }).catch(function(){ render([]); });
}
scan();
setInterval(scan, 8000);

function say(cls, msg){ var s = document.getElementById("status"); s.className = cls; s.textContent = msg; }

document.getElementById("f").onsubmit = function(e){
  e.preventDefault();
  var ssid = picked;
  if (!ssid) { say("err", "Pick a network first."); return; }
  var tzVal = document.getElementById("tz");
  var body = new URLSearchParams();
  body.set("ssid", ssid);
  body.set("psk", document.getElementById("psk").value);
  body.set("tz", tzVal ? tzVal.value : tz);
  body.set("lat", document.getElementById("lat").value);
  body.set("lon", document.getElementById("lon").value);
  body.set("server_url", document.getElementById("server_url").value);
  body.set("bind_code", document.getElementById("bind_code").value);
  document.getElementById("go").disabled = true;
  say("busy", "Saving…");
  fetch("/save", {method:"POST", body:body}).then(function(r){ return r.text(); }).then(function(t){
    say("ok", "Saved. The screen is joining " + ssid + " — it will drop off this network in a moment. You can close this tab.");
  }).catch(function(){ say("err", "Could not reach the screen. Are you still on its access point?"); })
    .then(function(){ document.getElementById("go").disabled = false; });
};
</script>
</body></html>)HTML";

  request->send(200, "text/html; charset=utf-8", html.c_str());
}

void ScanResultsListener::on_wifi_scan_results(const wifi::wifi_scan_vector_t<wifi::WiFiScanResult> &results) {
  // The first callback of the boot is the interesting one. After that, the
  // wizard polls the retained results and does not need telling again.
  const bool first = !this->scan_completed_;
  this->scan_completed_ = true;
  this->completed_count_++;

  ESP_LOGI("subwave.setup", "Scan complete (#%u): %u network(s) reported.", this->completed_count_,
           (unsigned) results.size());
  if (this->callback_)
    this->callback_();

  if (!first)
    return;

  // Hidden networks included. This is the only place the raw radio report is
  // ever written down, and "the radio reported nothing at all" is a different
  // fault from "the radio reported nothing we are willing to show" — with the
  // list on the glass alone, both look like an empty dropdown.
  for (const auto &scan : results) {
    ESP_LOGI(TAG, "Found WiFi network: '%s' RSSI: %d auth: %d hidden: %d", scan.get_ssid().c_str(),
             (int) scan.get_rssi(), (int) scan.get_with_auth(), (int) scan.get_is_hidden());
  }
  if (results.empty()) {
    ESP_LOGW(TAG, "The radio reported zero networks. That is the radio's answer, not a "
                 "filtered list — no filtering has run yet.");
  }
}

void SetupWebComponent::request_scan() {
  auto *wifi = wifi::global_wifi_component;
  if (wifi == nullptr)
    return;

  // STEP 1 OF 3: BRING THE COPROCESSOR'S STATION INTERFACE UP.
  //
  // THE SYMPTOM. The network list was permanently empty. Every scan attempt
  // returned ESP_ERR_WIFI_STATE or a bare ESP_FAIL, ap_num stayed at 0, and no
  // WIFI_EVENT_SCAN_DONE ever arrived — so on the glass it was an empty dropdown
  // next to a wizard that worked fine, which reads as "no WiFi here" rather than
  // "this call is refused".
  //
  // TWO SEPARATE FAULTS, AND BOTH HAVE TO BE FIXED.
  //
  //  (a) THE STATION INTERFACE IS NEVER BROUGHT UP. This device has no `sta:`
  //      network configured — it is an access point until somebody provisions
  //      it — so ESPHome's state machine, which is gated on `has_sta()`, never
  //      touches the station side. A coprocessor whose station interface was
  //      never started answers a scan request with a bare ESP_FAIL, which
  //      `rpc_rsp_callback()` returns for any slave failure it cannot map to a
  //      named esp_err — so the one error that matters carries no information.
  //
  //  (b) THE RADIO IS LEFT MID-SCAN. ESPHome runs a scan of its own during wifi
  //      setup. That scan does not finish, so the radio is stuck scanning, and
  //      `esp_wifi_scan_start` — and, misleadingly, `esp_wifi_scan_stop` too —
  //      return ESP_ERR_WIFI_STATE, which reads as "WiFi internal state error"
  //      and points at nothing.
  //
  // start_scanning() is called here because it runs
  // WiFiComponent::wifi_scan_start_(), whose first act is wifi_mode_(true, {}):
  // that is what puts the coprocessor into APSTA with a live station interface,
  // which is (a). It unavoidably also begins a scan, which is the start of (b) —
  // so the next two steps stop that scan and start a clean one.
  //
  // This is not idempotent in the way a bare start_scanning() would be, and that
  // is the point: tapping Scan twice replaces the running scan instead of being
  // refused by it.
  wifi->start_scanning();

  this->scan_attempts_ = 0;
  this->scan_phase_ = ScanPhase::STOP;
  // Wait before stopping. Measured on the device: a stop issued in the same tick
  // as the start it is meant to cancel does not land, and the stop that follows
  // one loop iteration later is refused because the scan has not begun yet.
  this->set_timeout("scan", 2000, [this]() { this->scan_start_pending_ = true; });
}

void SetupWebComponent::loop() {
  if (!this->scan_start_pending_)
    return;
  this->scan_start_pending_ = false;
  this->cancel_timeout("scan");

  // STEP 2: clear whatever is scanning, then wait again.
  if (this->scan_phase_ == ScanPhase::STOP) {
    esp_err_t stop_err = esp_wifi_scan_stop();
    if (stop_err != ESP_OK && stop_err != ESP_ERR_WIFI_STATE) {
      ESP_LOGW(TAG, "esp_wifi_scan_stop -> %s (continuing)", esp_err_to_name(stop_err));
    }
    this->scan_phase_ = ScanPhase::START;
    this->set_timeout("scan", 2000, [this]() { this->scan_start_pending_ = true; });
    return;
  }

  // STEP 3: start a clean scan.
  wifi_scan_config_t config{};
  config.ssid = nullptr;
  config.bssid = nullptr;
  config.channel = 0;
  config.show_hidden = true;
  config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
  config.scan_time.active.min = 100;
  config.scan_time.active.max = 300;

  esp_err_t err = esp_wifi_scan_start(&config, false);
  if (err == ESP_OK) {
    this->scan_attempts_ = 0;
    ESP_LOGI(TAG, "Scan requested.");
    return;
  }

  // Retry a few times before giving up. The coprocessor acknowledges the stop
  // RPC long before the radio has finished tearing the scan down, and there is
  // no way to ask how far along it is, so the only honest answer is to try
  // again.
  //
  // The give-up path CANCELLS the timer. Without that, the timer armed by the
  // last retry outlives the give-up, re-arms scan_start_pending_, and the whole
  // sequence starts again from zero — an endless retry that fills the log with
  // the same failure and never stops. Cancelling is what makes the bound real.
  if (++this->scan_attempts_ < 4) {
    ESP_LOGW(TAG, "esp_wifi_scan_start -> %s, retrying (%u/3).", esp_err_to_name(err),
             (unsigned) this->scan_attempts_);
    this->set_timeout("scan", 2000, [this]() { this->scan_start_pending_ = true; });
    return;
  }
  this->cancel_timeout("scan");
  this->scan_attempts_ = 0;
  ESP_LOGE(TAG, "esp_wifi_scan_start -> %s after 3 retries. The list cannot be filled.",
           esp_err_to_name(err));
}

void SetupWebComponent::log_radio_state() {
  // Ask the radio, not ESPHome. See the header for why this cannot be a lambda.
  //
  // ONE OBSERVATION PER CALL, NOT A SEQUENCE. An earlier version ran the whole
  // probe — stop, set mode, start, delay(4000), read — inside one call, and the
  // delay(4000) blocked the main loop long enough to trip the watchdog, so the
  // device rebooted before printing the answer.
  //
  // SILENT ONCE A SCAN HAS LANDED. The caller polls this every couple of seconds
  // for half a minute, and the question it answers — "did the scan come back,
  // and did the result survive the trip in?" — is only interesting until it does.
  // Logging the same line twelve times after the answer is known is noise that
  // hides the next fault.
  if (this->scan_completed())
    return;

  uint16_t ap_count = 0;
  esp_err_t err = esp_wifi_scan_get_ap_num(&ap_count);
  auto *wifi = wifi::global_wifi_component;

  ESP_LOGI(TAG, "radio: ap_num -> %s (%u), esp_home retained=%u, scans so far=%u",
           esp_err_to_name(err), (unsigned) ap_count,
           wifi == nullptr ? 0u : (unsigned) wifi->get_scan_result().size(),
           (unsigned) this->completed_count_);
}

void SetupWebComponent::setup() {
  // KEEP THE SCAN RESULTS, OR THE NETWORK LIST IS ALWAYS EMPTY.
  //
  // WiFiComponent::needs_full_scan_results_() decides whether a scan keeps
  // everything it hears or only the APs matching a configured network, and it
  // has exactly two ways to say "keep everything": keep_scan_results_, and:
  //
  //     #ifdef USE_CAPTIVE_PORTAL
  //       if (captive_portal::global_captive_portal != nullptr &&
  //           captive_portal::global_captive_portal->is_active())
  //         return true;
  //     #endif
  //
  // That second one is the captive portal, which is the whole reason ESPHome's
  // stock page had a working network list. We removed captive_portal: because it
  // claims every GET on the device, and removing it silently removed the only
  // thing keeping the scan results alive. WiFiComponent::release_scan_results_
  // then frees them, and the wizard shows an empty list forever.
  //
  // Nothing complains. The page renders, the JSON is valid, and there are
  // simply no networks in it — which reads as "there is no wifi here" rather
  // than "we deleted the list".
  if (auto *wifi = wifi::global_wifi_component) {
    wifi->set_keep_scan_results(true);
    ESP_LOGI(TAG, "retaining full WiFi scan results for the network list");
    // Hand the screen its hook BEFORE registering. If a scan were to complete
    // between registration and the callback being set, the on-screen list would
    // fill on the next scan instead of this one — and on a quiet band there may
    // not be a next one.
    if (this->on_scan_setup_ != nullptr) {
      this->set_on_scan_callback([this]() { this->on_scan_setup_(); });
    }
    wifi->add_scan_results_listener(this);
  }

  auto *base = web_server_base::global_web_server_base;
  if (base == nullptr) {
    ESP_LOGE(TAG, "no web_server_base — the wizard cannot be registered");
    return;
  }

  this->handler_ = new SetupWebHandler();
  this->handler_->set_station_name(this->station_name_);
  this->handler_->set_ap_ssid(this->ap_ssid_);

  // Without the auth middleware: this device has no web server password
  // configured, and more to the point a phone that cannot get to the wizard
  // cannot provision the screen at all.
  base->add_handler_without_auth(this->handler_);

  ESP_LOGI(TAG, "Setup wizard handler registered (first in queue: %s)",
           base->get_server() == nullptr ? "yes, via handlers_" : "no, server already up");
}

void SetupWebComponent::dump_config() {
  ESP_LOGCONFIG(TAG, "Setup Wizard:");
  ESP_LOGCONFIG(TAG, "  Station: %s", this->station_name_.c_str());
  ESP_LOGCONFIG(TAG, "  Setup AP: %s", this->ap_ssid_.c_str());
}

}  // namespace esphome::subwave_setup_web
