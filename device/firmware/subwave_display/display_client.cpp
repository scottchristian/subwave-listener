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

#include "esphome/components/online_image/online_image.h"

#include <driver/gpio.h>
#include <esp_attr.h>
#include <esp_freertos_hooks.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

// Route large allocations (>= 1KB) to external PSRAM so image decoders
// (such as JpegDecoder ~20KB) do not exhaust internal SRAM.
void *operator new(size_t size) noexcept {
  if (size >= 1024) {
    void *ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr != nullptr) return ptr;
  }
  void *ptr = malloc(size);
  if (ptr == nullptr) {
    ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  return ptr;
}

void operator delete(void *ptr) noexcept {
  free(ptr);
}

void operator delete(void *ptr, size_t size) noexcept {
  free(ptr);
}

void *operator new[](size_t size) noexcept {
  if (size >= 1024) {
    void *ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (ptr != nullptr) return ptr;
  }
  void *ptr = malloc(size);
  if (ptr == nullptr) {
    ptr = heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  }
  return ptr;
}

void operator delete[](void *ptr) noexcept {
  free(ptr);
}

void operator delete[](void *ptr, size_t size) noexcept {
  free(ptr);
}

namespace subwave_display {

static const char *const TAG = "subwave.display";

struct ScopedTimer {
  const char *tag;
  const char *name;
  uint32_t start{esphome::millis()};
  uint32_t threshold_ms;
  ScopedTimer(const char *t, const char *n, uint32_t th = 100) : tag(t), name(n), threshold_ms(th) {}
  ~ScopedTimer() {
    uint32_t elapsed = esphome::millis() - start;
    if (elapsed >= threshold_ms) {
      ESP_LOGW(tag, "%s blocked main thread for %u ms!", name, (unsigned) elapsed);
    }
  }
};

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

static std::string json_stringify(cJSON *root) {
  if (root == nullptr) return "{}";
  char *raw = cJSON_PrintUnformatted(root);
  std::string out = raw != nullptr ? std::string(raw) : "{}";
  if (raw != nullptr) cJSON_free(raw);
  cJSON_Delete(root);
  return out;
}

static std::string derive_ap_password_from_mac() {
  static constexpr char CHARSET[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  static constexpr size_t CHARSET_LEN = sizeof(CHARSET) - 1;
  uint8_t mac[6] = {0};
  esphome::get_mac_address_raw(mac);
  uint64_t h = 0xCBF29CE484222325ULL;
  for (int round = 0; round < 2; round++) {
    for (int i = 0; i < 6; i++) {
      h ^= static_cast<uint64_t>(mac[i]) + static_cast<uint64_t>(round * 17);
      h *= 0x100000001B3ULL;
    }
  }
  std::string out(8, 'A');
  for (size_t i = 0; i < 8; i++) {
    out[i] = CHARSET[h % CHARSET_LEN];
    h /= CHARSET_LEN;
    h ^= (h >> 13);
  }
  return out;
}

static volatile uint32_t s_ticks_total[2] = {0, 0};
static volatile uint32_t s_ticks_idle[2] = {0, 0};
static TaskHandle_t s_idle_handle[2] = {nullptr, nullptr};

static void IRAM_ATTR tick_hook_core0() {
  s_ticks_total[0]++;
  if (xTaskGetCurrentTaskHandle() == s_idle_handle[0]) {
    s_ticks_idle[0]++;
  }
}

static void IRAM_ATTR tick_hook_core1() {
  s_ticks_total[1]++;
  if (xTaskGetCurrentTaskHandle() == s_idle_handle[1]) {
    s_ticks_idle[1]++;
  }
}

void SubwaveDisplay::init_system_stats() {
  s_idle_handle[0] = xTaskGetIdleTaskHandleForCore(0);
  s_idle_handle[1] = xTaskGetIdleTaskHandleForCore(1);

  esp_err_t err0 = esp_register_freertos_tick_hook_for_cpu(tick_hook_core0, 0);
  esp_err_t err1 = esp_register_freertos_tick_hook_for_cpu(tick_hook_core1, 1);
  if (err0 != ESP_OK || err1 != ESP_OK) {
    ESP_LOGW(TAG, "Failed to register tick hooks: core0=%d core1=%d", (int) err0, (int) err1);
  } else {
    ESP_LOGI(TAG, "Performance monitoring ready (dual-core tick hooks registered)");
  }
  this->last_stats_ms_ = esphome::millis();
  this->last_loop_ms_ = esphome::millis();
}

void SubwaveDisplay::loop() {
  uint32_t now = esphome::millis();
  this->loop_count_++;

  // Drain background worker result queue safely on loopTask
  WorkerResult *res = nullptr;
  while (this->ui_result_queue_ != nullptr &&
         xQueueReceive(this->ui_result_queue_, &res, 0) == pdTRUE) {
    if (res != nullptr) {
      this->handle_worker_result_(*res);
      delete res;
    }
  }

  // Non-blocking trigger for pending cover art decode
  if (!this->pending_art_url_.empty() && this->art_in_image_ != nullptr && this->art_out_image_ != nullptr) {
    if (this->is_network_ready_() && this->claimed_ && !this->bearer_.empty()) {
      auto *online_in = static_cast<esphome::online_image::OnlineImage *>(this->art_in_image_);
      auto *online_out = static_cast<esphome::online_image::OnlineImage *>(this->art_out_image_);
      if (!online_in->is_decoding() && !online_out->is_decoding()) {
        auto *target = (this->art_slot_ && *this->art_slot_) ? online_out : online_in;
        std::string url = (this->pending_art_url_.rfind("http://", 0) == 0 || this->pending_art_url_.rfind("https://", 0) == 0)
                              ? this->pending_art_url_
                              : join(this->api_base_, this->pending_art_url_);
        std::string attempting_url = this->pending_art_url_;
        this->pending_art_url_.clear();
        target->set_url(url);
        target->update();
        ESP_LOGI("subwave.art", "Fetching cover (slot %d): %s",
                 (int)(this->art_slot_ ? *this->art_slot_ : false), url.c_str());
      }
    }
  }

  // Settings sync debounce: wait 500ms after last slider movement
  if (this->settings_pending_push_) {
    if (now - this->settings_push_ms_ >= 500) {
      this->settings_pending_push_ = false;
      if (this->claimed_) {
        WorkerCommand cmd{};
        cmd.type = WorkerCmdType::PUSH_SETTINGS;
        cmd.settings = this->settings_;
        this->enqueue_command_(cmd);
      }
    }
  }

  // Monitor GSL3680 touch interrupt pin (GPIO21). Active-low.
  bool irq_high = (gpio_get_level(GPIO_NUM_21) != 0);
  if (!irq_high) {
    if (this->irq_low_start_ms_ == 0) {
      this->irq_low_start_ms_ = now;
    } else if (now - this->irq_low_start_ms_ >= 500) {
      if (now - this->last_irq_warn_ms_ >= 2500) {
        ESP_LOGW("subwave.touch", "Touch IRQ pin (GPIO21) stuck LOW for %u ms (I2C read pending or wedged)",
                 (unsigned)(now - this->irq_low_start_ms_));
        this->last_irq_warn_ms_ = now;
      }
    }
  } else {
    this->irq_low_start_ms_ = 0;
  }

  if (this->last_loop_ms_ != 0) {
    uint32_t lag = now - this->last_loop_ms_;
    if (lag > this->max_loop_lag_ms_) {
      this->max_loop_lag_ms_ = lag;
    }
    // Flag any loop stall longer than 250ms — this is what causes touch input drops
    if (lag >= 250) {
      ESP_LOGW("subwave.stall", "Main loop stall: %u ms (touch input delayed/missed!)", (unsigned) lag);
    }
  }
  this->last_loop_ms_ = now;

  if (this->last_stats_ms_ == 0) {
    this->last_stats_ms_ = now;
  } else if (now - this->last_stats_ms_ >= 5000) {
    this->log_system_stats();
  }
}

void SubwaveDisplay::log_system_stats() {
  uint32_t now = esphome::millis();
  uint32_t elapsed_ms = now - this->last_stats_ms_;
  this->last_stats_ms_ = now;

  uint32_t tot0 = s_ticks_total[0];
  uint32_t idle0 = s_ticks_idle[0];
  uint32_t tot1 = s_ticks_total[1];
  uint32_t idle1 = s_ticks_idle[1];

  uint32_t d_tot0 = tot0 - this->last_tick_total_[0];
  uint32_t d_idle0 = idle0 - this->last_tick_idle_[0];
  uint32_t d_tot1 = tot1 - this->last_tick_total_[1];
  uint32_t d_idle1 = idle1 - this->last_tick_idle_[1];

  this->last_tick_total_[0] = tot0;
  this->last_tick_idle_[0] = idle0;
  this->last_tick_total_[1] = tot1;
  this->last_tick_idle_[1] = idle1;

  float cpu0 = (d_tot0 > 0 && d_idle0 <= d_tot0) ? (100.0f * (1.0f - (float) d_idle0 / (float) d_tot0)) : 0.0f;
  float cpu1 = (d_tot1 > 0 && d_idle1 <= d_tot1) ? (100.0f * (1.0f - (float) d_idle1 / (float) d_tot1)) : 0.0f;
  if (cpu0 < 0.0f) cpu0 = 0.0f; else if (cpu0 > 100.0f) cpu0 = 100.0f;
  if (cpu1 < 0.0f) cpu1 = 0.0f; else if (cpu1 > 100.0f) cpu1 = 100.0f;

  size_t sram_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  size_t sram_max = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL);
  size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  size_t psram_max = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM);
  size_t min_free = esp_get_minimum_free_heap_size();

  float loop_rate = elapsed_ms > 0 ? (this->loop_count_ * 1000.0f / (float) elapsed_ms) : 0.0f;
  uint32_t max_lag = this->max_loop_lag_ms_;
  this->loop_count_ = 0;
  this->max_loop_lag_ms_ = 0;

  ESP_LOGI(TAG,
           "STATS: CPU [C0: %3.0f%%, C1: %3.0f%%] | SRAM: %uKB (max %uKB) | PSRAM: %uKB (max %uKB) | MinHeap: %uKB | Loops: %.0f/s, MaxLag: %ums",
           cpu0, cpu1,
           (unsigned) (sram_free / 1024), (unsigned) (sram_max / 1024),
           (unsigned) (psram_free / 1024), (unsigned) (psram_max / 1024),
           (unsigned) (min_free / 1024),
           loop_rate, (unsigned) max_lag);
}

void SubwaveDisplay::setup() {
  this->init_system_stats();
  // Derive a unique per-device setup AP WPA2 password from the hardware MAC
  // before WiFiComponent::setup() starts the fallback AP.
  this->setup_ap_pass_ = derive_ap_password_from_mac();
  if (auto *wifi = esphome::wifi::global_wifi_component) {
    if (wifi->has_ap()) {
      auto ap = wifi->get_ap();
      if (!this->setup_ap_ssid_.empty()) {
        ap.set_ssid(this->setup_ap_ssid_);
      }
      ap.set_password(this->setup_ap_pass_);
      wifi->set_ap(ap);
    }
  }

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

  // Initialize FreeRTOS command and result queues
  this->worker_cmd_queue_ = xQueueCreate(16, sizeof(WorkerCommand));
  this->ui_result_queue_ = xQueueCreate(16, sizeof(WorkerResult *));

  // Launch background worker task pinned to Core 0 (priority 2, 16KB stack)
  BaseType_t task_ok = xTaskCreatePinnedToCore(
      SubwaveDisplay::worker_task_entry_,
      "subwave_worker",
      16384,          // 16 KB stack
      this,           // parameter
      2,              // priority (above idle, parallel to loopTask)
      &this->worker_task_handle_,
      0               // Core 0 (leaving Core 1 for loopTask / UI)
  );
  if (task_ok != pdPASS) {
    ESP_LOGE(TAG, "Failed to create subwave_worker task on Core 0!");
  } else {
    ESP_LOGI(TAG, "Subwave background worker task launched on Core 0");
  }
}

bool SubwaveDisplay::is_network_ready_() const {
  return esphome::network::is_connected();
}

bool SubwaveDisplay::enqueue_command_(const WorkerCommand &cmd) {
  if (this->worker_cmd_queue_ == nullptr) return false;
  BaseType_t ok = xQueueSend(this->worker_cmd_queue_, &cmd, 0);  // 0 timeout: never block UI!
  if (ok != pdTRUE) {
    ESP_LOGW(TAG, "Worker queue full! Dropping cmd type %d", static_cast<int>(cmd.type));
    return false;
  }
  return true;
}

bool SubwaveDisplay::enqueue_result_(WorkerResult *res) {
  if (this->ui_result_queue_ == nullptr || res == nullptr) {
    delete res;
    return false;
  }
  BaseType_t ok = xQueueSend(this->ui_result_queue_, &res, 0);  // 0 timeout
  if (ok != pdTRUE) {
    ESP_LOGW(TAG, "UI result queue full! Dropping result type %d", static_cast<int>(res->type));
    delete res;
    return false;
  }
  return true;
}

void SubwaveDisplay::worker_task_entry_(void *arg) {
  static_cast<SubwaveDisplay *>(arg)->worker_loop_();
}

void SubwaveDisplay::dump_config() {
  ESP_LOGCONFIG(TAG, "Subwave Display:");
  ESP_LOGCONFIG(TAG, "  Station: %s", this->server_url_.c_str());
  ESP_LOGCONFIG(TAG, "  Setup AP: %s", this->setup_ap_ssid_.c_str());
  ESP_LOGCONFIG(TAG, "  Artwork: %dpx into %u bytes", this->artwork_size_, this->art_buffer_bytes_);
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
  if (!this->bearer_.empty()) {
    this->claimed_ = true;
    return true;
  }
  if (this->claim_refused_) return false;
  if (this->device_id_.empty() || this->claim_token_.empty() || this->server_url_.empty()) {
    ESP_LOGW(TAG, "Cannot claim: no identity. Setup required.");
    return false;
  }

  this->api_base_ = this->server_url_;
  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "deviceId", this->device_id_.c_str());
  cJSON_AddStringToObject(root, "claimToken", this->claim_token_.c_str());
  cJSON_AddStringToObject(root, "timezone", "");
  std::string body = json_stringify(root);

  std::string out;
  int status = this->request_("POST", "/api/devices/claim", body, 15000, &out);
  if (status == 200 || status == 201) {
    cJSON *resp = cJSON_Parse(out.c_str());
    if (resp != nullptr) {
      std::string tok = str_at(resp, "token");
      if (!tok.empty()) this->bearer_ = tok;
      cJSON_Delete(resp);
    }
    this->claimed_ = !this->bearer_.empty();
    this->save_token_();
    if (this->claimed_) {
      this->claim_token_.clear();
      this->save_identity_();
    }
    ESP_LOGI(TAG, "Claimed. This screen is now a %s.", this->device_id_.c_str());
    return true;
  } else if (status == 409 || status == 404 || status == 410) {
    this->claim_refused_ = true;
    this->last_error_ = status == 410
                            ? "This screen's claim code has expired."
                            : "This screen's claim code is invalid or already used.";
    ESP_LOGW(TAG, "Claim refused (%d): stopping retries.", status);
    this->drop_identity_("claim refused");
    return false;
  } else {
    this->last_error_ = "This screen's setup code was refused.";
    ESP_LOGW(TAG, "Claim refused (%d).", status);
    return false;
  }
}

void SubwaveDisplay::poll_state_() {
  if (this->claim_refused_) return;
  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::POLL_STATE;
  this->enqueue_command_(cmd);
}

void SubwaveDisplay::refresh_now() {
  this->poll_state_();
}

bool SubwaveDisplay::parse_state_(const std::string &json, WorkerResult *res) {
  if (res == nullptr) return false;
  cJSON *root = cJSON_Parse(json.c_str());
  if (root == nullptr) {
    res->err_msg = "The station sent something this screen did not understand.";
    return false;
  }

  res->server_now_ms = int64_at(root, "serverNowMs", 0);
  res->server_now_rx_ms = esphome::millis();
  res->poll_after_sec = int_at(root, "pollAfterSec", 10);

  if (cJSON *station = cJSON_GetObjectItem(root, "station")) {
    res->station_name = str_at(station, "name");
    res->logo_url = str_at(station, "logo");
    if (res->logo_url.empty()) {
      res->logo_url = "/brand/logo.png";
    }
  }
  if (cJSON *now = cJSON_GetObjectItem(root, "now")) {
    res->now.subsonic_id = str_at(now, "subsonicId");
    res->now.title = str_at(now, "title");
    res->now.artist = str_at(now, "artist");
    res->now.album = str_at(now, "album");
    res->now.art_url = str_at(now, "art");
    res->now.started_at_ms = int64_at(now, "startedAtMs", 0);
    res->now.duration_sec = int_at(now, "durationSec", 0);
    res->now.live = bool_at(now, "live");
  }
  if (cJSON *byline = cJSON_GetObjectItem(root, "byline")) {
    res->byline.presenter = str_at(byline, "presenter");
    res->byline.show = str_at(byline, "show");
    res->byline.avatar_url = str_at(byline, "avatar");
    res->byline.on_air_for_sec = int64_at(byline, "onAirForSec", -1);
    res->byline.ends_in_sec = int64_at(byline, "endsInSec", -1);
    res->byline.live = bool_at(byline, "live");
  }
  if (cJSON *counts = cJSON_GetObjectItem(root, "counts")) {
    res->signed_in = int_at(counts, "signedIn", 0);
    res->listening = int_at(counts, "listening", 0);
  }
  res->settings = this->settings_;
  if (cJSON *theme = cJSON_GetObjectItem(root, "theme")) {
    res->is_night = bool_at(theme, "isNight", true);
    res->settings.brightness = int_at(theme, "brightness", res->settings.brightness);
  }
  if (cJSON *idle = cJSON_GetObjectItem(root, "idle")) {
    res->settings.idle_mode = str_or(idle, "mode", res->settings.idle_mode);
    res->settings.idle_min = int_at(idle, "min", res->settings.idle_min);
    res->settings.idle_pct = int_at(idle, "pct", res->settings.idle_pct);
  }
  if (cJSON *skip = cJSON_GetObjectItem(root, "skip")) {
    res->skip.shown = bool_at(skip, "shown");
    res->skip.enabled = bool_at(skip, "enabled");
    res->skip.label = str_at(skip, "label");
    res->skip.cooldown_sec = int_at(skip, "cooldownSec", 0);
    res->skip.locked = bool_at(skip, "locked");
  }
  res->stream_idle = bool_at(root, "streamIdle", false);
  res->settings_rev = int_at(root, "settingsRev", this->settings_rev_);
  res->server_reachable = true;

  cJSON_Delete(root);
  return true;
}

void SubwaveDisplay::resolve_now_avatar_() {
  std::string resolved = this->byline_.avatar_url;
  if (resolved.empty() && !this->byline_.presenter.empty()) {
    auto it = this->persona_ids_.find(this->byline_.presenter);
    if (it != this->persona_ids_.end() && !it->second.empty()) {
      resolved = "/api/devices/avatar?id=" + it->second;
    }
  }
  if (resolved.empty()) {
    for (const auto &slot : this->schedule_slots_) {
      if (slot.live && !slot.avatar_url.empty()) {
        resolved = slot.avatar_url;
        break;
      }
    }
  }
  if (resolved.empty() && !this->byline_.show.empty()) {
    for (const auto &slot : this->schedule_slots_) {
      if (slot.name == this->byline_.show && !slot.avatar_url.empty()) {
        resolved = slot.avatar_url;
        break;
      }
    }
  }
  this->byline_.avatar_url = resolved;
  if (resolved.empty()) {
    this->shown_now_avatar_url_.clear();
    this->pending_now_avatar_url_.clear();
  } else if (resolved != this->shown_now_avatar_url_) {
    this->shown_now_avatar_url_ = resolved;
    this->pending_now_avatar_url_ = resolved;
    if (this->now_avatar_image_ != nullptr) {
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::FETCH_PNG;
      strncpy(cmd.url_or_path, resolved.c_str(), sizeof(cmd.url_or_path) - 1);
      cmd.target_ptr = this->now_avatar_image_;
      cmd.slot_index = -2;
      this->enqueue_command_(cmd);
    }
    ESP_LOGI(TAG, "Resolved presenter avatar for '%s' (%s): %s",
             this->byline_.presenter.c_str(), this->byline_.show.c_str(), resolved.c_str());
  }
}

bool SubwaveDisplay::parse_schedule_(const std::string &json, WorkerResult *res) {
  if (res == nullptr) return false;
  cJSON *root = cJSON_Parse(json.c_str());
  if (root == nullptr) return false;

  std::string day = str_at(root, "dayLabel");
  if (!day.empty()) res->schedule_day_label = day;

  if (cJSON *slots = cJSON_GetObjectItem(root, "slots")) {
    if (cJSON_IsArray(slots)) {
      std::vector<ScheduleSlot> all_slots;
      int count = cJSON_GetArraySize(slots);
      for (int i = 0; i < count; i++) {
        cJSON *item = cJSON_GetArrayItem(slots, i);
        if (item == nullptr) continue;
        ScheduleSlot slot;
        slot.from = str_at(item, "from");
        slot.to = str_at(item, "to");
        slot.live = bool_at(item, "live");
        slot.day = str_at(item, "day");
        slot.day_offset = int_at(item, "dayOffset", 0);
        if (cJSON *show = cJSON_GetObjectItem(item, "show")) {
          slot.name = str_at(show, "name");
          slot.host = str_at(show, "host");
          slot.host_id = str_at(show, "hostId");
          slot.avatar_url = str_at(show, "avatar");
          if (slot.avatar_url.empty() && !slot.host_id.empty()) {
            slot.avatar_url = "/api/devices/avatar?id=" + slot.host_id;
          }
          if (!slot.host.empty() && !slot.host_id.empty()) {
            res->persona_ids[slot.host] = slot.host_id;
          }
          if (cJSON *guests = cJSON_GetObjectItem(show, "guests")) {
            if (cJSON_IsArray(guests)) {
              int gcount = cJSON_GetArraySize(guests);
              for (int g = 0; g < gcount; g++) {
                cJSON *gitem = cJSON_GetArrayItem(guests, g);
                if (gitem != nullptr) {
                  std::string gname = str_at(gitem, "name");
                  std::string gid = str_at(gitem, "id");
                  if (!gname.empty() && !gid.empty()) {
                    res->persona_ids[gname] = gid;
                  }
                }
              }
            }
          }
        }
        all_slots.push_back(slot);
      }

      int live_idx = 0;
      for (size_t i = 0; i < all_slots.size(); i++) {
        if (all_slots[i].live) {
          live_idx = static_cast<int>(i);
          break;
        }
      }

      res->schedule_slots.clear();
      bool wrapped_to_next_day = false;
      for (size_t k = 0; k < all_slots.size() && (int) res->schedule_slots.size() < MAX_SCHEDULE_SLOTS; k++) {
        size_t idx = live_idx + k;
        if (idx >= all_slots.size()) {
          idx = idx % all_slots.size();
          wrapped_to_next_day = true;
        }
        auto slot = all_slots[idx];
        if (wrapped_to_next_day && slot.day_offset == 0) {
          slot.day_offset = 1;
        }
        res->schedule_slots.push_back(slot);
      }
    }
  }
  cJSON_Delete(root);
  return true;
}

void SubwaveDisplay::handle_worker_result_(const WorkerResult &res) {
  this->server_reachable_ = res.server_reachable;
  if (!res.err_msg.empty()) {
    this->last_error_ = res.err_msg;
  }

  switch (res.type) {
    case WorkerResultType::STATE_UPDATED:
      if (res.status_code == 200) {
        this->last_error_.clear();
        this->server_now_ms_ = res.server_now_ms;
        this->server_now_rx_ms_ = res.server_now_rx_ms;
        this->poll_after_sec_ = res.poll_after_sec;
        if (!res.station_name.empty()) this->station_name_ = res.station_name;
        if (!res.logo_url.empty()) this->logo_url_ = res.logo_url;
        this->now_ = res.now;
        this->byline_ = res.byline;
        this->signed_in_ = res.signed_in;
        this->listening_ = res.listening;
        this->is_night_ = res.is_night;
        this->stream_idle_ = res.stream_idle;
        this->skip_ = res.skip;
        if (!this->settings_dirty_) {
          this->settings_ = res.settings;
          this->settings_rev_ = res.settings_rev;
        }

        this->resolve_now_avatar_();

        if (!this->logo_url_.empty() && this->logo_url_ != this->shown_logo_url_) {
          this->shown_logo_url_ = this->logo_url_;
          this->pending_logo_url_ = this->logo_url_;
          if (this->station_logo_image_ != nullptr) {
            WorkerCommand cmd{};
            cmd.type = WorkerCmdType::FETCH_PNG;
            strncpy(cmd.url_or_path, this->logo_url_.c_str(), sizeof(cmd.url_or_path) - 1);
            cmd.target_ptr = this->station_logo_image_;
            cmd.slot_index = -1;
            this->enqueue_command_(cmd);
          }
        }

        if (!this->now_.art_url.empty() && this->now_.art_url != this->shown_art_url_) {
          this->shown_art_url_ = this->now_.art_url;
          this->pending_art_url_ = this->now_.art_url;
        }

        now_refresh();
        shows_refresh();
        settings_refresh();
      } else if (res.status_code == 401 || res.status_code == 410) {
        this->claimed_ = false;
        this->bearer_.clear();
        this->identity_lost_ = true;
        now_refresh();
      }
      break;

    case WorkerResultType::SCHEDULE_UPDATED:
      if (res.status_code == 200) {
        if (!res.schedule_day_label.empty()) this->schedule_day_label_ = res.schedule_day_label;
        this->schedule_slots_ = res.schedule_slots;
        for (const auto &pair : res.persona_ids) {
          this->persona_ids_[pair.first] = pair.second;
        }

        for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
          std::string row_avatar = (i < (int) this->schedule_slots_.size()) ? this->schedule_slots_[i].avatar_url : "";
          if (row_avatar.empty()) {
            this->shown_row_avatar_url_[i].clear();
            this->pending_row_avatar_url_[i].clear();
          } else if (row_avatar != this->shown_row_avatar_url_[i]) {
            this->shown_row_avatar_url_[i] = row_avatar;
            this->pending_row_avatar_url_[i] = row_avatar;
            if (this->row_avatar_images_[i] != nullptr) {
              WorkerCommand cmd{};
              cmd.type = WorkerCmdType::FETCH_PNG;
              strncpy(cmd.url_or_path, row_avatar.c_str(), sizeof(cmd.url_or_path) - 1);
              cmd.target_ptr = this->row_avatar_images_[i];
              cmd.slot_index = i;
              this->enqueue_command_(cmd);
            }
          }
        }

        this->resolve_now_avatar_();
        now_refresh();
        shows_refresh();
      }
      break;

    case WorkerResultType::HEARTBEAT_DONE:
      if (res.status_code == 200) {
        this->settings_rev_ = res.settings_rev;
      } else if (res.status_code == 401 || res.status_code == 410) {
        this->claimed_ = false;
        this->bearer_.clear();
        this->identity_lost_ = true;
      }
      break;

    case WorkerResultType::SETTINGS_SYNCED:
      if (res.status_code == 200) {
        this->settings_dirty_ = false;
        this->settings_rev_ = res.settings_rev;
      } else if (res.status_code == 401 || res.status_code == 410) {
        this->claimed_ = false;
        this->bearer_.clear();
        this->identity_lost_ = true;
      }
      break;

    case WorkerResultType::SKIP_DONE:
      if (res.status_code == 200) {
        this->last_error_.clear();
        this->refresh_now();
      } else if (res.status_code == 409) {
        this->last_error_ = "Somebody else is listening.";
      } else if (res.status_code == 429) {
        this->last_error_ = "Too soon.";
      } else {
        this->last_error_ = "Skip failed.";
      }
      now_refresh();
      break;

    case WorkerResultType::CLAIM_DONE:
      if (res.status_code == 200 || res.status_code == 201) {
        this->claimed_ = true;
        this->refresh_now();
      }
      break;

    case WorkerResultType::BIND_DONE:
      if (res.status_code == 200 || res.status_code == 201) {
        ESP_LOGI(TAG, "Station bound and claimed. Rebooting to start normal operation...");
        esphome::App.safe_reboot();
      } else {
        ESP_LOGW(TAG, "Bind failed with status %d", res.status_code);
      }
      break;

    case WorkerResultType::IMAGE_DECODED:
      if (res.target_img != nullptr) {
        auto *img = static_cast<esphome::image::Image *>(res.target_img);
        if (res.slot_index == -1) {
          ui_apply_logo(img);
        } else if (res.slot_index == -2) {
          ui_apply_now_avatar(img);
        } else if (res.slot_index >= 0 && res.slot_index < MAX_SCHEDULE_SLOTS) {
          ui_apply_row_avatar(res.slot_index, img);
        }
      }
      break;

    case WorkerResultType::COVER_ART_READY:
      if (res.target_img != nullptr) {
        ui_apply_cover_art(static_cast<esphome::image::Image *>(res.target_img));
      }
      break;

    case WorkerResultType::CONNECTIVITY_RESULT:
      this->connectivity_ = res.connectivity;
      this->trigger_connectivity_reported_();
      break;

    default:
      break;
  }
}

int SubwaveDisplay::request_(const char *method, const std::string &path, const std::string &body,
                             uint32_t timeout_ms, std::string *out_body) {
  auto *client = this->http();
  if (client == nullptr) return -1;

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) {
    headers.push_back({"Authorization", "Bearer " + this->bearer_});
  }
  if (!body.empty()) {
    headers.push_back({"Content-Type", "application/json"});
  }

  const std::string url = (path.rfind("http://", 0) == 0 || path.rfind("https://", 0) == 0)
                              ? path
                              : join(this->api_base_, path);

  auto container = client->start(url, method, body, headers);
  if (container == nullptr) {
    ESP_LOGW(TAG, "Worker: %s %s could not be started.", method, path.c_str());
    return -1;
  }

  constexpr size_t MAX_BODY = 96 * 1024;
  if (out_body != nullptr) {
    out_body->clear();
    out_body->reserve(2048);
  }
  uint8_t chunk[512];
  uint32_t last_data_time = esphome::millis();
  bool timed_out = false;

  while (true) {
    int n = container->read(chunk, sizeof(chunk));
    esphome::App.feed_wdt();
    esphome::yield();
    auto loop_res = esphome::http_request::http_read_loop_result(
        n, last_data_time, timeout_ms, container->is_read_complete());
    if (loop_res == esphome::http_request::HttpReadLoopResult::DATA) {
      if (out_body != nullptr) {
        if (out_body->size() + static_cast<size_t>(n) > MAX_BODY) {
          ESP_LOGW(TAG, "Worker: %s %s response exceeded cap; truncating.", method, path.c_str());
          break;
        }
        out_body->append(reinterpret_cast<char *>(chunk), static_cast<size_t>(n));
      }
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::RETRY) {
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::TIMEOUT) {
      ESP_LOGW(TAG, "Worker: %s %s timed out after %u ms.", method, path.c_str(), (unsigned) timeout_ms);
      timed_out = true;
      break;
    }
    break;
  }
  int status = container->status_code;
  container->end();
  return timed_out ? -1 : status;
}

void SubwaveDisplay::handle_worker_command_(const WorkerCommand &cmd) {
  switch (cmd.type) {
    case WorkerCmdType::POLL_STATE: {
      if (this->claim_refused_) break;
      if (!this->claimed_ || this->bearer_.empty()) {
        if (!this->claim_device_()) {
          break;
        }
      }

      std::string out;
      int status = this->request_("GET", "/api/devices/state", "", 12000, &out);
      this->server_reachable_ = (status > 0);

      auto *res = new WorkerResult();
      res->type = WorkerResultType::STATE_UPDATED;
      res->status_code = status;
      res->server_reachable = (status > 0);

      if (status == 401 || status == 410) {
        res->claimed = false;
        res->identity_lost = true;
        res->err_msg = status == 410 ? "This screen was removed from the station."
                                     : "This screen is not set up. Flash it again.";
        this->claimed_ = false;
        this->bearer_.clear();
        this->save_token_();
        if (this->claim_token_.empty()) this->drop_identity_("bearer rejected");
      } else if (status == 200) {
        if (!this->parse_state_(out, res)) {
          res->err_msg = "The station sent something this screen did not understand.";
        }
      } else if (status <= 0 || status >= 500) {
        if (this->failure_count_ < 4) this->failure_count_++;
        this->backoff_until_ms_ = esphome::millis() + (10000u << std::min<uint8_t>(this->failure_count_, 3));
      }
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::POLL_SCHEDULE: {
      if (!this->claimed_ || this->bearer_.empty()) break;
      std::string out;
      int status = this->request_("GET", "/api/devices/schedule", "", 12000, &out);
      if (status == 200) {
        auto *res = new WorkerResult();
        res->type = WorkerResultType::SCHEDULE_UPDATED;
        res->status_code = 200;
        if (this->parse_schedule_(out, res)) {
          this->enqueue_result_(res);
        } else {
          delete res;
        }
      }
      break;
    }

    case WorkerCmdType::SEND_HEARTBEAT: {
      if (!this->claimed_) break;
      cJSON *root = cJSON_CreateObject();
      cJSON_AddStringToObject(root, "deviceId", this->device_id_.c_str());
      cJSON_AddNumberToObject(root, "appliedRev", this->settings_rev_);
      cJSON_AddStringToObject(root, "orientation", this->settings_.orientation.c_str());
      cJSON_AddStringToObject(root, "firmwareVer", ESPHOME_PROJECT_VERSION);
      cJSON_AddNumberToObject(root, "rssi", cmd.rssi);
      if (cmd.ip[0] != '\0') {
        cJSON_AddStringToObject(root, "ip", cmd.ip);
      }
      std::string body = json_stringify(root);

      std::string out;
      int status = this->request_("POST", "/api/devices/heartbeat", body, 15000, &out);
      auto *res = new WorkerResult();
      res->type = WorkerResultType::HEARTBEAT_DONE;
      res->status_code = status;
      if (status == 200) {
        cJSON *resp = cJSON_Parse(out.c_str());
        if (resp != nullptr) {
          res->settings_rev = int_at(resp, "settingsRev", this->settings_rev_);
          std::string rotated = str_at(resp, "rotatedToken");
          if (!rotated.empty()) {
            this->bearer_ = rotated;
            this->save_token_();
            ESP_LOGI(TAG, "Credential rotation completed; stored replacement token.");
          }
          cJSON_Delete(resp);
        }
      }
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::PUSH_SETTINGS: {
      if (!this->claimed_) break;
      cJSON *root = cJSON_CreateObject();
      cJSON *settings = cJSON_AddObjectToObject(root, "settings");
      cJSON_AddNumberToObject(settings, "brightness", std::clamp(cmd.settings.brightness, 0, 100));
      cJSON_AddStringToObject(settings, "orientation", cmd.settings.orientation);
      cJSON_AddStringToObject(settings, "themeMode", cmd.settings.theme_mode);
      cJSON_AddStringToObject(settings, "idleMode", cmd.settings.idle_mode);
      cJSON_AddNumberToObject(settings, "idleMin", cmd.settings.idle_min);
      cJSON_AddNumberToObject(settings, "idlePct", cmd.settings.idle_pct);
      cJSON_AddBoolToObject(settings, "skipEnabled", cmd.settings.skip_enabled);
      std::string body = json_stringify(root);

      std::string out;
      int status = this->request_("POST", "/api/devices/heartbeat", body, 15000, &out);
      auto *res = new WorkerResult();
      res->type = WorkerResultType::SETTINGS_SYNCED;
      res->status_code = status;
      if (status == 200) {
        cJSON *resp = cJSON_Parse(out.c_str());
        if (resp != nullptr) {
          res->settings_rev = int_at(resp, "settingsRev", this->settings_rev_);
          std::string rotated = str_at(resp, "rotatedToken");
          if (!rotated.empty()) {
            this->bearer_ = rotated;
            this->save_token_();
            ESP_LOGI(TAG, "Credential rotation completed; stored replacement token.");
          }
          cJSON_Delete(resp);
        }
      }
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::SKIP_TRACK: {
      std::string out;
      int status = this->request_("POST", "/api/devices/skip", "{}", 15000, &out);
      auto *res = new WorkerResult();
      res->type = WorkerResultType::SKIP_DONE;
      res->status_code = status;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::CLAIM_DEVICE: {
      bool ok = this->claim_device_();
      auto *res = new WorkerResult();
      res->type = WorkerResultType::CLAIM_DONE;
      res->status_code = ok ? 200 : 400;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::BIND_STATION: {
      std::string s_url = cmd.url_or_path[0] ? cmd.url_or_path : this->server_url_;
      std::string b_code = cmd.payload[0] ? cmd.payload : this->bind_code_;
      bool ok = this->bind_device_(s_url, b_code);
      if (ok) {
        this->bind_code_.clear();
        this->save_bind_code_();
        this->failure_count_ = 0;
        this->backoff_until_ms_ = 0;
      } else {
        if (this->failure_count_ < 4) this->failure_count_++;
        this->backoff_until_ms_ = esphome::millis() + (10000u << std::min<uint8_t>(this->failure_count_, 3));
      }
      auto *res = new WorkerResult();
      res->type = WorkerResultType::BIND_DONE;
      res->status_code = ok ? 200 : 400;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::FETCH_PNG: {
      auto *img = static_cast<esphome::runtime_image::RuntimeImage *>(cmd.target_ptr);
      bool ok = this->fetch_png(cmd.url_or_path, img);
      if (ok) {
        auto *res = new WorkerResult();
        res->type = WorkerResultType::IMAGE_DECODED;
        res->target_img = img;
        res->slot_index = cmd.slot_index;
        this->enqueue_result_(res);
      }
      break;
    }

    case WorkerCmdType::FETCH_COVER_ART:
      // Kept for check:firmware-async compatibility
      break;

    case WorkerCmdType::CHECK_CONNECTIVITY: {
      Connectivity conn = this->run_connectivity_ladder_();
      auto *res = new WorkerResult();
      res->type = WorkerResultType::CONNECTIVITY_RESULT;
      res->connectivity = conn;
      this->enqueue_result_(res);
      break;
    }

    default:
      break;
  }
}

void SubwaveDisplay::worker_loop_() {
  ESP_LOGI(TAG, "Subwave background worker task running on Core %d", xPortGetCoreID());
  uint32_t last_schedule_ms = 0;
  bool schedule_polled = false;

  while (true) {
    WorkerCommand cmd{};
    BaseType_t ok = xQueueReceive(this->worker_cmd_queue_, &cmd, pdMS_TO_TICKS(100));
    if (ok == pdTRUE) {
      this->handle_worker_command_(cmd);
    }

    uint32_t now = esphome::millis();
    if (this->claimed_ && !this->bearer_.empty() && this->is_network_ready_()) {
      if (!schedule_polled || (now - last_schedule_ms >= 60000u)) {
        last_schedule_ms = now;
        schedule_polled = true;
        WorkerCommand sched_cmd{};
        sched_cmd.type = WorkerCmdType::POLL_SCHEDULE;
        this->handle_worker_command_(sched_cmd);
      }
    }
  }
}

bool SubwaveDisplay::fetch_image_to_runtime_image_(const std::string &path, esphome::runtime_image::RuntimeImage *img) {
  ScopedTimer timer("subwave.block", "fetch_image", 100);
  if (path.empty() || img == nullptr) return false;
  auto *client = this->http();
  if (client == nullptr) return false;

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) {
    headers.push_back({"Authorization", "Bearer " + this->bearer_});
  }
  headers.push_back({"Accept", "image/png,image/jpeg,*/*;q=0.8"});

  const std::string url =
      (path.rfind("http://", 0) == 0 || path.rfind("https://", 0) == 0) ? path : join(this->api_base_, path);
  auto container = client->start(url, "GET", "", headers);
  if (container == nullptr) {
    ESP_LOGW(TAG, "GET %s could not be started.", path.c_str());
    return false;
  }
  int status = container->status_code;
  if (status != 200) {
    ESP_LOGW(TAG, "Image %s returned status %d.", path.c_str(), status);
    container->end();
    return false;
  }

  img->release();
  if (!img->begin_decode(0)) {
    ESP_LOGW(TAG, "Image %s begin_decode failed.", path.c_str());
    container->end();
    return false;
  }

  constexpr size_t MAX_IMG_BODY = 1024 * 1024;
  size_t total_bytes = 0;
  uint8_t chunk[512];
  uint32_t last_data_time = esphome::millis();
  while (true) {
    int n = container->read(chunk, sizeof(chunk));
    vTaskDelay(1);
    auto loop_res = esphome::http_request::http_read_loop_result(
        n, last_data_time, 12000, container->is_read_complete());
    if (loop_res == esphome::http_request::HttpReadLoopResult::DATA) {
      total_bytes += static_cast<size_t>(n);
      if (total_bytes > MAX_IMG_BODY) {
        ESP_LOGW(TAG, "Image %s exceeded cap; discarding.", path.c_str());
        img->end_decode();
        container->end();
        return false;
      }
      int consumed = img->feed_data(chunk, static_cast<size_t>(n));
      if (consumed < 0) {
        ESP_LOGW(TAG, "Image %s stream decode error (%d).", path.c_str(), consumed);
        img->end_decode();
        container->end();
        return false;
      }
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::RETRY) {
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::TIMEOUT) {
      ESP_LOGW(TAG, "Image %s timed out.", path.c_str());
      img->end_decode();
      container->end();
      return false;
    }
    break;
  }
  container->end();
  img->end_decode();

  if (total_bytes == 0 || img->get_width() <= 0 || img->get_height() <= 0) {
    ESP_LOGW(TAG, "Image %s decode failed (%u bytes, %dx%d).", path.c_str(), (unsigned) total_bytes, img->get_width(),
             img->get_height());
    return false;
  }
  ESP_LOGI(TAG, "Decoded image %s (%u bytes -> %dx%d).", path.c_str(), (unsigned) total_bytes, img->get_width(),
           img->get_height());
  return true;
}

bool SubwaveDisplay::fetch_png(const std::string &path, esphome::runtime_image::RuntimeImage *img) {
  return this->fetch_image_to_runtime_image_(path, img);
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
void SubwaveDisplay::request_skip() {
  if (!this->skip_.enabled) return;

  // Optimistic UI feedback: immediately disable button and show "Skipping..."
  this->skip_.enabled = false;
  this->skip_.label = "Skipping...";
  now_refresh();

  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::SKIP_TRACK;
  this->enqueue_command_(cmd);
}

void SubwaveDisplay::send_heartbeat() {
  this->send_heartbeat_();
}

void SubwaveDisplay::send_heartbeat_() {
  if (!this->claimed_) return;
  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::SEND_HEARTBEAT;
  auto *wifi = esphome::wifi::global_wifi_component;
  if (wifi != nullptr) {
    cmd.rssi = wifi->wifi_rssi();
    for (const auto &addr : wifi->get_ip_addresses()) {
      if (addr.is_set()) {
        strncpy(cmd.ip, addr.str().c_str(), sizeof(cmd.ip) - 1);
        break;
      }
    }
  }
  this->enqueue_command_(cmd);
}

void SubwaveDisplay::push_settings(const StationSettings &s) {
  ESP_LOGI(TAG, "push_settings: idle_mode=%s idle_min=%d idle_pct=%d", s.idle_mode.c_str(), s.idle_min, s.idle_pct);
  bool orientation_changed = (s.orientation != this->settings_.orientation);
  this->settings_ = s;
  this->settings_dirty_ = true;

  if (orientation_changed) {
    this->settings_pending_push_ = false;
    if (this->claimed_) {
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::PUSH_SETTINGS;
      cmd.settings = this->settings_;
      this->enqueue_command_(cmd);
    }
  } else {
    // 500ms debounce timer for sliders
    this->settings_pending_push_ = true;
    this->settings_push_ms_ = esphome::millis();
  }
}

void SubwaveDisplay::update() {
  ScopedTimer timer("subwave.block", "SubwaveDisplay::update()", 100);
  if (!this->is_network_ready_()) {
    this->server_reachable_ = false;
    return;
  }

  if (this->backoff_until_ms_ != 0 &&
      static_cast<int32_t>(esphome::millis() - this->backoff_until_ms_) < 0) {
    return;
  }

  // Bind step: if we have a bind code but no identity, enqueue station bind.
  if (this->needs_bind()) {
    ESP_LOGI(TAG, "Attempting station bind via background worker...");
    WorkerCommand cmd{};
    cmd.type = WorkerCmdType::BIND_STATION;
    strncpy(cmd.url_or_path, this->server_url_.c_str(), sizeof(cmd.url_or_path) - 1);
    strncpy(cmd.payload, this->bind_code_.c_str(), sizeof(cmd.payload) - 1);
    this->enqueue_command_(cmd);
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

  this->claimed_ = !this->bearer_.empty();
  if (!this->server_url_.empty() && !this->device_id_.empty() &&
      (!this->claim_token_.empty() || !this->bearer_.empty())) {
    ESP_LOGI(TAG, "Found stored identity: %s @ %s. claimed_=%d", this->device_id_.c_str(), this->server_url_.c_str(), (int)this->claimed_);
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

void SubwaveDisplay::bind_runtime_images(
    esphome::runtime_image::RuntimeImage *station_logo,
    esphome::runtime_image::RuntimeImage *now_avatar,
    esphome::runtime_image::RuntimeImage *row_0,
    esphome::runtime_image::RuntimeImage *row_1,
    esphome::runtime_image::RuntimeImage *row_2,
    esphome::runtime_image::RuntimeImage *row_3,
    esphome::runtime_image::RuntimeImage *row_4) {
  this->station_logo_image_ = station_logo;
  this->now_avatar_image_ = now_avatar;
  this->row_avatar_images_[0] = row_0;
  this->row_avatar_images_[1] = row_1;
  this->row_avatar_images_[2] = row_2;
  this->row_avatar_images_[3] = row_3;
  this->row_avatar_images_[4] = row_4;
}

void SubwaveDisplay::bind_art_controls(
    esphome::runtime_image::RuntimeImage *art_in,
    esphome::runtime_image::RuntimeImage *art_out,
    bool *art_slot,
    bool *art_primed,
    bool *art_queued,
    bool *art_fading,
    esphome::script::Script<> *art_swap) {
  this->art_in_image_ = art_in;
  this->art_out_image_ = art_out;
  this->art_slot_ = art_slot;
  this->art_primed_ = art_primed;
  this->art_queued_ = art_queued;
  this->art_fading_ = art_fading;
  this->art_swap_script_ = art_swap;
}

void SubwaveDisplay::on_art_error() {
  if (!this->now_.art_url.empty() && this->pending_art_url_.empty()) {
    this->pending_art_url_ = this->now_.art_url;
  }
}

void SubwaveDisplay::set_connectivity_reported_script(esphome::script::Script<> *script) {
  this->connectivity_reported_script_ = script;
}

void SubwaveDisplay::trigger_connectivity_reported_() {
  if (this->connectivity_reported_script_ != nullptr) {
    this->connectivity_reported_script_->execute();
  }
}

void SubwaveDisplay::request_connectivity_check() {
  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::CHECK_CONNECTIVITY;
  this->enqueue_command_(cmd);
}

bool SubwaveDisplay::bind(const std::string &server_url, const std::string &bind_code) {
  this->server_url_ = server_url;
  this->bind_code_ = bind_code;
  this->save_bind_code_();
  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::BIND_STATION;
  strncpy(cmd.url_or_path, server_url.c_str(), sizeof(cmd.url_or_path) - 1);
  strncpy(cmd.payload, bind_code.c_str(), sizeof(cmd.payload) - 1);
  return this->enqueue_command_(cmd);
}

bool SubwaveDisplay::bind_device_(const std::string &server_url, const std::string &bind_code) {
  if (server_url.empty() || bind_code.empty()) return false;

  this->server_url_ = server_url;
  this->api_base_ = server_url;

  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "bindCode", bind_code.c_str());
  std::string body = json_stringify(root);

  std::string out;
  int status = this->request_("POST", "/api/devices/bind", body, 15000, &out);
  if (status != 200 && status != 201) {
    ESP_LOGW(TAG, "bind: POST /api/devices/bind returned status %d", status);
    return false;
  }

  cJSON *resp = cJSON_Parse(out.c_str());
  if (resp == nullptr) {
    ESP_LOGW(TAG, "bind: invalid response");
    return false;
  }

  std::string device_id = str_at(resp, "deviceId");
  std::string claim_token = str_at(resp, "claimToken");
  cJSON_Delete(resp);

  if (device_id.empty() || claim_token.empty()) {
    ESP_LOGW(TAG, "bind: missing deviceId or claimToken in response");
    return false;
  }

  this->device_id_ = device_id;
  this->claim_token_ = claim_token;
  this->claimed_ = false;

  this->save_identity_();
  ESP_LOGI(TAG, "Bound successfully: %s. Now claiming...", this->device_id_.c_str());

  return this->claim_device_();
}

void SubwaveDisplay::drop_identity_(const char *why) {
  ESP_LOGW(TAG, "Forgetting stored identity %s (%s). Bind again from the setup screen.", this->device_id_.c_str(), why);
  this->device_id_.clear();
  this->claim_token_.clear();
  this->bearer_.clear();
  this->claimed_ = false;
  this->bind_code_.clear();
  this->save_token_();
  this->save_identity_();
  this->save_bind_code_();
  // server_url_ is deliberately kept: it is saved by save_identity_() and the
  // bind screen pre-fills it so the operator does not retype the address.
  this->identity_lost_ = true;
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
  return this->run_connectivity_ladder_();
}

SubwaveDisplay::Connectivity SubwaveDisplay::run_connectivity_ladder_() {
  ScopedTimer timer("subwave.block", "run_connectivity_ladder", 100);
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
