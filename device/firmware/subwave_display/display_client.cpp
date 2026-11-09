#include "display_client.h"
// The painters. parse_state_ has to call them itself — see below.
#include "ui.h"

#include <cJSON.h>
#include <ctime>
#include <cstring>
#include <algorithm>
#include <memory>

#include "esphome/core/log.h"
#include "esphome/core/application.h"
#include "esphome/core/defines.h"
#include "esphome/core/hal.h"
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
// Firmware OTA. The app image format and the partition that holds it are the
// IDF's, not ours: the install writes through esp_ota_* so the bootloader's own
// A/B swap and rollback behaviour is what decides which app starts.
#include <esp_app_format.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <mbedtls/sha256.h>
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
      if (xPortGetCoreID() == 1) {
        ESP_LOGW(tag, "%s blocked main thread for %u ms!", name, (unsigned) elapsed);
      } else {
        ESP_LOGD(tag, "%s took %u ms on background worker (Core %d)", name, (unsigned) elapsed, xPortGetCoreID());
      }
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

  // Retry the modal portrait only while the modal is open; closing it stops the
  // retries, and the backoff after a failure lives in ensure_modal_avatar_().
  if (this->presenter_modal_state_.open) {
    this->ensure_modal_avatar_();
  }

  // Non-blocking trigger for pending cover art decode on background worker (Core 0)
  if (!this->pending_art_url_.empty() && this->art_in_image_ != nullptr && this->art_out_image_ != nullptr) {
    if (this->is_network_ready_() && this->claimed_ && !this->bearer_.empty() && !this->cover_in_flight_) {
      auto *target = (this->art_slot_ && *this->art_slot_) ? this->art_out_image_ : this->art_in_image_;
      std::string url = (this->pending_art_url_.rfind("http://", 0) == 0 || this->pending_art_url_.rfind("https://", 0) == 0)
                            ? this->pending_art_url_
                            : join(this->api_base_, this->pending_art_url_);
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::FETCH_COVER_ART;
      strncpy(cmd.url_or_path, url.c_str(), sizeof(cmd.url_or_path) - 1);
      cmd.target_ptr = target;
      cmd.slot_index = (this->art_slot_ && *this->art_slot_) ? 1 : 0;
      if (this->enqueue_command_(cmd)) {
        this->pending_art_url_.clear();
        this->cover_in_flight_ = true;
        ESP_LOGI("subwave.art", "Enqueued background cover fetch (slot %d): %s",
                 cmd.slot_index, url.c_str());
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

  if (this->first_loop_) {
    this->first_loop_ = false;
    this->last_loop_ms_ = now;
    this->max_loop_lag_ms_ = 0;
  } else if (this->last_loop_ms_ != 0) {
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

  // Before the worker exists and before the first heartbeat can be enqueued:
  // the journal decides whether the previous boot owes the station a report,
  // and the running-image fingerprint decides what "up to date" means.
  this->ota_init_();

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
  // Only the UI consumer can clear cover_in_flight_, so its completion must not be dropped.
  TickType_t wait_ticks = res->type == WorkerResultType::COVER_ART_READY ? portMAX_DELAY : 0;
  BaseType_t ok = xQueueSend(this->ui_result_queue_, &res, wait_ticks);
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
    res->byline.tagline = str_at(byline, "tagline");
    res->byline.on_air_for_sec = int64_at(byline, "onAirForSec", -1);
    res->byline.ends_in_sec = int64_at(byline, "endsInSec", -1);
    res->byline.live = bool_at(byline, "live");
    if (cJSON *pres = cJSON_GetObjectItem(byline, "presenters")) {
      if (cJSON_IsArray(pres)) {
        int pcount = cJSON_GetArraySize(pres);
        for (int p = 0; p < pcount; p++) {
          cJSON *pitem = cJSON_GetArrayItem(pres, p);
          if (pitem != nullptr) {
            PresenterInfo pi;
            pi.id = str_at(pitem, "id");
            pi.name = str_at(pitem, "name");
            pi.role = str_at(pitem, "role");
            pi.tagline = str_at(pitem, "tagline");
            pi.avatar_url = str_at(pitem, "avatar");
            // The first entry is the host, and the byline carries the same bio
            // and avatar at show level. Falling back per field means a payload
            // that omits them on the entry still shows the bio instead of
            // "No bio provided for this presenter."
            if (p == 0) {
              if (pi.tagline.empty()) pi.tagline = res->byline.tagline;
              if (pi.avatar_url.empty()) pi.avatar_url = res->byline.avatar_url;
            }
            if (!pi.name.empty()) {
              res->byline.presenters.push_back(pi);
            }
          }
        }
      }
    }
    if (res->byline.presenters.empty() && !res->byline.presenter.empty()) {
      PresenterInfo pi;
      pi.name = res->byline.presenter;
      pi.role = "Host";
      pi.tagline = res->byline.tagline;
      pi.avatar_url = res->byline.avatar_url;
      res->byline.presenters.push_back(pi);
    }
    if (res->byline.presenters.size() > 1) {
      std::string combined;
      for (size_t p = 0; p < res->byline.presenters.size(); p++) {
        if (p == 0) {
          combined = res->byline.presenters[p].name;
        } else if (p == res->byline.presenters.size() - 1) {
          combined += " & " + res->byline.presenters[p].name;
        } else {
          combined += ", " + res->byline.presenters[p].name;
        }
      }
      res->byline.presenter = combined;
    }
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

  // The co-host's face. A show with two hosts paints both, side by side, so the
  // second portrait gets its own buffer and its own request.
  std::string co_host;
  if (this->byline_.presenters.size() > 1) {
    co_host = this->byline_.presenters[1].avatar_url;
    if (co_host.empty()) {
      auto it = this->persona_ids_.find(this->byline_.presenters[1].name);
      if (it != this->persona_ids_.end() && !it->second.empty()) {
        co_host = "/api/devices/avatar?id=" + it->second;
      }
    }
  }
  if (co_host.empty()) {
    this->pending_now_avatar_2_url_.clear();
    this->shown_now_avatar_2_url_.clear();
  } else if (co_host != this->shown_now_avatar_2_url_ &&
             co_host != this->pending_now_avatar_2_url_) {
    if (this->now_avatar_2_image_ != nullptr) {
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::FETCH_PNG;
      strncpy(cmd.url_or_path, co_host.c_str(), sizeof(cmd.url_or_path) - 1);
      cmd.target_ptr = this->now_avatar_2_image_;
      cmd.slot_index = -4;
      // In flight only once the queue owns it, so a full queue retries on the
      // next poll instead of waiting forever for a request that never happened.
      if (this->enqueue_command_(cmd)) {
        this->pending_now_avatar_2_url_ = co_host;
      }
    }
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
          slot.tagline = str_at(show, "tagline");
          if (slot.avatar_url.empty() && !slot.host_id.empty()) {
            slot.avatar_url = "/api/devices/avatar?id=" + slot.host_id;
          }
          if (!slot.host.empty() && !slot.host_id.empty()) {
            res->persona_ids[slot.host] = slot.host_id;
          }
          if (cJSON *pres = cJSON_GetObjectItem(show, "presenters")) {
            if (cJSON_IsArray(pres)) {
              int pcount = cJSON_GetArraySize(pres);
              for (int p = 0; p < pcount; p++) {
                cJSON *pitem = cJSON_GetArrayItem(pres, p);
                if (pitem != nullptr) {
                  PresenterInfo pi;
                  pi.id = str_at(pitem, "id");
                  pi.name = str_at(pitem, "name");
                  pi.role = str_at(pitem, "role");
                  pi.tagline = str_at(pitem, "tagline");
                  pi.avatar_url = str_at(pitem, "avatar");
                  // Same rule as the byline: the slot's own tagline/avatar is
                  // the host's, so it may fill the first presenter's gaps.
                  if (p == 0) {
                    if (pi.tagline.empty()) pi.tagline = slot.tagline;
                    if (pi.avatar_url.empty()) pi.avatar_url = slot.avatar_url;
                  }
                  if (!pi.name.empty()) {
                    slot.presenters.push_back(pi);
                  }
                }
              }
            }
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
                  if (slot.presenters.empty()) {
                    PresenterInfo guest_p;
                    guest_p.id = gid;
                    guest_p.name = gname;
                    guest_p.role = str_at(gitem, "role");
                    if (guest_p.role.empty()) guest_p.role = "Guest";
                    guest_p.tagline = str_at(gitem, "tagline");
                    guest_p.avatar_url = str_at(gitem, "avatar");
                    if (!guest_p.name.empty()) {
                      slot.presenters.push_back(guest_p);
                    }
                  }
                }
              }
            }
          }
          if (slot.presenters.empty() && !slot.host.empty()) {
            PresenterInfo host_p;
            host_p.id = slot.host_id;
            host_p.name = slot.host;
            host_p.role = "Host";
            host_p.tagline = slot.tagline;
            host_p.avatar_url = slot.avatar_url;
            slot.presenters.insert(slot.presenters.begin(), host_p);
          }
          if (slot.presenters.size() > 1) {
            std::string combined;
            for (size_t p = 0; p < slot.presenters.size(); p++) {
              if (p == 0) {
                combined = slot.presenters[p].name;
              } else if (p == slot.presenters.size() - 1) {
                combined += " & " + slot.presenters[p].name;
              } else {
                combined += ", " + slot.presenters[p].name;
              }
            }
            slot.host = combined;
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

        // The second presenter on each row, so a two-host show reads as two
        // faces rather than one face and a name.
        for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
          std::string second;
          if (i < (int) this->schedule_slots_.size() && this->schedule_slots_[i].presenters.size() > 1) {
            second = this->schedule_slots_[i].presenters[1].avatar_url;
          }
          if (second.empty()) {
            this->shown_row_avatar2_url_[i].clear();
            this->pending_row_avatar2_url_[i].clear();
          } else if (second != this->shown_row_avatar2_url_[i] &&
                     second != this->pending_row_avatar2_url_[i]) {
            if (this->row_avatar2_images_[i] != nullptr) {
              WorkerCommand cmd{};
              cmd.type = WorkerCmdType::FETCH_PNG;
              strncpy(cmd.url_or_path, second.c_str(), sizeof(cmd.url_or_path) - 1);
              cmd.target_ptr = this->row_avatar2_images_[i];
              cmd.slot_index = -5 - i;
              if (this->enqueue_command_(cmd)) {
                this->pending_row_avatar2_url_[i] = second;
              }
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
      if (res.slot_index == -3) {
        // A slow reply for a presenter the user has already swiped past must
        // not paint over the face now on screen.
        if (res.url.empty() || res.url != this->modal_avatar_requested_url_) break;
        this->modal_avatar_requested_url_.clear();
        if (res.status_code == 200 && res.target_img != nullptr) {
          this->modal_avatar_retry_ms_ = 0;
          this->shown_modal_avatar_url_ = res.url;
          ui_apply_modal_avatar(static_cast<esphome::image::Image *>(res.target_img));
        } else {
          // Nothing is recorded as shown, so the modal asks again after a
          // short pause instead of leaving the 280 well empty until it closes.
          this->modal_avatar_retry_ms_ = esphome::millis() + 3000;
        }
        break;
      }
      if (res.slot_index == -4) {
        // The co-host portrait. Only the one still wanted may paint.
        if (res.url.empty() || res.url != this->pending_now_avatar_2_url_) break;
        this->pending_now_avatar_2_url_.clear();
        if (res.status_code == 200 && res.target_img != nullptr) {
          this->shown_now_avatar_2_url_ = res.url;
          ui_apply_now_avatar_2(static_cast<esphome::image::Image *>(res.target_img));
        } else {
          // Hide the well rather than leave an empty frame where a face should
          // be; the next poll asks again.
          this->shown_now_avatar_2_url_.clear();
          ui_hide_now_avatar_2();
        }
        break;
      }
      if (res.slot_index <= -5 && res.slot_index >= -5 - (MAX_SCHEDULE_SLOTS - 1)) {
        // The second face on a schedule row. Checked and cleared outside the
        // decode-success branch so a failed fetch releases the in-flight marker
        // and the next schedule poll asks again instead of leaving the row with
        // the previous show's co-host forever.
        const int slot = -5 - res.slot_index;
        if (res.url.empty() || res.url != this->pending_row_avatar2_url_[slot]) break;
        this->pending_row_avatar2_url_[slot].clear();
        if (res.status_code == 200 && res.target_img != nullptr) {
          this->shown_row_avatar2_url_[slot] = res.url;
          ui_apply_row_avatar_2(slot, static_cast<esphome::image::Image *>(res.target_img));
        }
        break;
      }
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

    case WorkerResultType::COVER_ART_READY: {
      auto *img = static_cast<esphome::runtime_image::RuntimeImage *>(res.target_img);
      if (img != nullptr && img->get_data_start() != nullptr && img->get_width() > 0 && img->get_height() > 0) {
        ESP_LOGI("subwave.art", "Cover ready in %s (%dx%d)",
                 img == this->art_out_image_ ? "art_out_image" : "art_in_image",
                 img->get_width(), img->get_height());
        ui_apply_cover_art(img, res.slot_index);
        if (this->art_primed_ != nullptr) *this->art_primed_ = true;
        if (this->art_fading_ != nullptr && !*this->art_fading_) {
          if (this->art_swap_script_ != nullptr) this->art_swap_script_->execute();
        } else if (this->art_queued_ != nullptr) {
          *this->art_queued_ = true;
        }
      } else {
        ESP_LOGW("subwave.art", "Cover art result was null or invalid; triggering retry");
        this->on_art_error();
      }
      this->cover_in_flight_ = false;
      break;
    }

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
      auto *res = new WorkerResult();
      res->type = WorkerResultType::HEARTBEAT_DONE;
      res->status_code =
          this->send_heartbeat_request_(cmd.ip, cmd.rssi, &res->settings_rev, nullptr, nullptr);
      // A pending request or an interrupted install may now have an attempt to
      // act on. ota_resume_ installs nothing unless the tap wrote that intent.
      if (res->status_code == 200) this->ota_resume_();
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
      // Report failures too. A dropped fetch used to be invisible to the UI,
      // which had already assumed the image was coming and never asked again.
      auto *res = new WorkerResult();
      res->type = WorkerResultType::IMAGE_DECODED;
      res->target_img = ok ? img : nullptr;
      res->slot_index = cmd.slot_index;
      res->status_code = ok ? 200 : 500;
      res->url = cmd.url_or_path;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::FETCH_COVER_ART: {
      auto *img = static_cast<esphome::runtime_image::RuntimeImage *>(cmd.target_ptr);
      bool ok = this->fetch_cover_to_runtime_image_(cmd.url_or_path, img);
      auto *res = new WorkerResult();
      res->type = WorkerResultType::COVER_ART_READY;
      res->target_img = ok ? img : nullptr;
      res->slot_index = cmd.slot_index;
      res->status_code = ok ? 200 : 500;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::CHECK_CONNECTIVITY: {
      Connectivity conn = this->run_connectivity_ladder_();
      auto *res = new WorkerResult();
      res->type = WorkerResultType::CONNECTIVITY_RESULT;
      res->connectivity = conn;
      this->enqueue_result_(res);
      break;
    }

    case WorkerCmdType::OTA_INSTALL: {
      this->ota_handle_tap_();
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
  return this->fetch_png_cached_(path, img);
}

bool SubwaveDisplay::fetch_cover_to_runtime_image_(const std::string &path, esphome::runtime_image::RuntimeImage *img) {
  ScopedTimer timer("subwave.block", "fetch_cover", 100);
  if (path.empty() || img == nullptr) return false;
  auto *client = this->http();
  if (client == nullptr) return false;

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) {
    headers.push_back({"Authorization", "Bearer " + this->bearer_});
  }
  headers.push_back({"Accept", "image/jpeg,image/png,*/*;q=0.8"});

  const std::string url =
      (path.rfind("http://", 0) == 0 || path.rfind("https://", 0) == 0) ? path : join(this->api_base_, path);
  auto container = client->start(url, "GET", "", headers);
  if (container == nullptr) {
    ESP_LOGW("subwave.art", "GET cover %s could not be started.", path.c_str());
    return false;
  }
  int status = container->status_code;
  if (status != 200) {
    ESP_LOGW("subwave.art", "Cover %s returned HTTP status %d.", path.c_str(), status);
    container->end();
    return false;
  }

  std::vector<uint8_t> body;
  if (container->content_length > 0 && container->content_length <= 2 * 1024 * 1024) {
    body.reserve(container->content_length);
  }

  uint8_t chunk[2048];
  uint32_t last_data_time = esphome::millis();
  while (true) {
    int n = container->read(chunk, sizeof(chunk));
    vTaskDelay(1);
    auto loop_res = esphome::http_request::http_read_loop_result(
        n, last_data_time, 12000, container->is_read_complete());
    if (loop_res == esphome::http_request::HttpReadLoopResult::DATA) {
      body.insert(body.end(), chunk, chunk + n);
      if (body.size() > 2 * 1024 * 1024) {
        ESP_LOGW("subwave.art", "Cover %s exceeded 2MB limit; aborting.", path.c_str());
        container->end();
        return false;
      }
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::RETRY) {
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::TIMEOUT) {
      ESP_LOGW("subwave.art", "Cover %s timed out during download.", path.c_str());
      container->end();
      return false;
    }
    break;
  }
  container->end();

  if (body.empty()) {
    ESP_LOGW("subwave.art", "Cover %s returned empty body.", path.c_str());
    return false;
  }

  img->release();
  if (!img->begin_decode(body.size())) {
    ESP_LOGW("subwave.art", "Cover %s begin_decode failed.", path.c_str());
    return false;
  }

  int consumed = img->feed_data(body.data(), body.size());
  img->end_decode();

  if (consumed < 0 || img->get_width() <= 0 || img->get_height() <= 0) {
    ESP_LOGW("subwave.art", "Cover %s stream decode error (consumed: %d, dims: %dx%d).",
             path.c_str(), consumed, img->get_width(), img->get_height());
    return false;
  }

  ESP_LOGI("subwave.art", "Decoded cover %s (%u bytes -> %dx%d) on Core %d.",
           path.c_str(), (unsigned) body.size(), img->get_width(), img->get_height(), xPortGetCoreID());
  return true;
}

// ---------------------------------------------------------------------------
// Shared firmware releases, installed from this screen's own Settings.
//
// ONE IMAGE FOR EVERY SCREEN, AN EXPLICIT TAP TO INSTALL IT, AND A RECORD THAT
// OUTLIVES A RESET. The station publishes one release; a heartbeat announces it.
// Nothing here downloads anything until somebody standing at the screen asks,
// and no heartbeat can start an install on its own: the decision requires a
// journal phase that only the tap writes.
//
// THE JOURNAL IS THE LOAD-BEARING PART. A screen that loses power while writing
// the inactive slot comes back with no memory of what it was doing. The server
// only knows the attempt by an id it issued, and the image alone cannot say
// whether "still running the old app" means "the download never finished" or
// "the new app crashed and the bootloader rolled back". So the attempt is
// written to NVS before the first byte is fetched and updated at every boundary.
//
// EVERY BYTE CROSSES THE WORKER. Download, checksum, flash write and reboot all
// happen on Core 0; the UI only ever reads a mutex-protected snapshot. A
// multi-megabyte HTTPS download on the LVGL core is the exact stall this
// component's design exists to avoid.
// ---------------------------------------------------------------------------

namespace {

/** The one URL this firmware will ever fetch an image from. Not a parameter. */
constexpr const char *OTA_DOWNLOAD_PATH = "/api/devices/ota";
/** The station's own floor for a plausible app image, and one slot's ceiling. */
constexpr uint32_t OTA_MIN_BYTES = 320;
constexpr uint32_t OTA_MAX_BYTES = 0x7C0000;

void ota_set_field(char *dst, size_t cap, const std::string &value) {
  if (cap == 0) return;
  size_t n = std::min(value.size(), cap - 1);
  if (n > 0) memcpy(dst, value.data(), n);
  dst[n] = '\0';
}

bool ota_state_is_downloadable(const std::string &state) {
  return state == "accepted" || state == "downloading" || state == "verifying" || state == "installing";
}

bool ota_state_is_terminal(const std::string &state) {
  return state == "succeeded" || state == "failed" || state == "rolled_back" || state == "unknown" ||
         state == "rejected";
}

std::string ota_hex(const uint8_t *digest, size_t len) {
  static const char *const HEX = "0123456789abcdef";
  std::string out(len * 2, '0');
  for (size_t i = 0; i < len; ++i) {
    out[2 * i] = HEX[digest[i] >> 4];
    out[2 * i + 1] = HEX[digest[i] & 0x0F];
  }
  return out;
}

bool ota_hex_matches(const std::string &expected, const std::string &actual) {
  if (expected.size() != 64 || actual.size() != 64) return false;
  for (size_t i = 0; i < 64; ++i) {
    char a = expected[i];
    char b = actual[i];
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

/**
 * A fresh request id: 20 characters from the alphabet the station accepts.
 *
 * Derived from the MAC and the current millisecond, so two screens cannot
 * collide and one screen's two taps always differ. It is NOT a secret and is
 * never used as a credential; the bearer token is what authorises the request.
 */
std::string ota_new_request_id() {
  uint8_t mac[6] = {0};
  esphome::get_mac_address_raw(mac);
  uint64_t h = 0xCBF29CE484222325ULL ^ (static_cast<uint64_t>(esphome::millis()) << 16);
  for (int i = 0; i < 6; ++i) {
    h ^= mac[i];
    h *= 0x100000001B3ULL;
  }
  char buf[24];
  snprintf(buf, sizeof(buf), "ota-%04x%04x%04x%04x", static_cast<unsigned>(h & 0xFFFF),
           static_cast<unsigned>((h >> 16) & 0xFFFF), static_cast<unsigned>((h >> 32) & 0xFFFF),
           static_cast<unsigned>((h >> 48) & 0xFFFF));
  return std::string(buf);
}

/**
 * What the person at the screen is told.
 *
 * The cause, in one sentence, and always as an instruction rather than a code:
 * the person reading it has no log and no other way to find out which of a
 * dozen things went wrong.
 */
const char *ota_message_for_notice(const std::string &notice) {
  if (notice == "publication_changed") return "The published firmware changed. Tap to review it.";
  if (notice == "already_in_progress") return "An update is already in progress.";
  if (notice == "rotation_in_progress") return "Finishing a security update. Try again in a moment.";
  if (notice == "release_unavailable") return "That firmware is no longer available.";
  if (notice == "request_rejected") return "The station refused this update.";
  if (notice == "bad_request") return "The station could not read this update request.";
  if (notice == "device_revoked") return "This screen was removed from the station.";
  if (notice == "stale_report") return "That update had already finished.";
  if (notice == "bad_report") return "The station could not read this screen's report.";
  if (notice == "installed_not_reported") return "Waiting for the station to confirm the update.";
  if (notice == "success_mismatch") return "The screen booted a different image than was published.";
  return "The station refused this update.";
}

}  // namespace

int SubwaveDisplay::send_heartbeat_request_(const char *ip, int rssi, int *settings_rev,
                                            OtaAttemptInfo *attempt_out, std::string *notice_out) {
  if (attempt_out != nullptr) *attempt_out = OtaAttemptInfo{};
  if (notice_out != nullptr) notice_out->clear();
  if (!this->claimed_) return -1;

  cJSON *root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "deviceId", this->device_id_.c_str());
  cJSON_AddNumberToObject(root, "appliedRev", this->settings_rev_);
  cJSON_AddStringToObject(root, "orientation", this->settings_.orientation.c_str());
  cJSON_AddStringToObject(root, "firmwareVer", ESPHOME_PROJECT_VERSION);
  // Absent means "no opinion": a tap-triggered heartbeat does not pretend to
  // know the signal, and the 45-second one still reports it.
  if (rssi != 0) cJSON_AddNumberToObject(root, "rssi", rssi);
  if (ip != nullptr && ip[0] != '\0') cJSON_AddStringToObject(root, "ip", ip);
  cJSON *ota = cJSON_AddObjectToObject(root, "ota");
  this->ota_prepare_heartbeat_(ota);
  std::string body = json_stringify(root);

  std::string out;
  const int status = this->request_("POST", "/api/devices/heartbeat", body, 20000, &out);
  if (status == 200) {
    cJSON *resp = cJSON_Parse(out.c_str());
    if (resp != nullptr) {
      if (settings_rev != nullptr) *settings_rev = int_at(resp, "settingsRev", this->settings_rev_);
      const std::string rotated = str_at(resp, "rotatedToken");
      if (!rotated.empty()) {
        this->bearer_ = rotated;
        this->save_token_();
        ESP_LOGI(TAG, "Credential rotation completed; stored replacement token.");
      }
      this->ota_apply_heartbeat_(cJSON_GetObjectItem(resp, "ota"), attempt_out, notice_out);
      cJSON_Delete(resp);
    }
  }
  return status;
}

void SubwaveDisplay::ota_prepare_heartbeat_(cJSON *ota) {
  if (ota == nullptr) return;
  cJSON_AddBoolToObject(ota, "capable", true);

  // What this screen is actually running. A fact about the device, not about
  // the install — and the only evidence the station accepts for "succeeded".
  cJSON *installed = cJSON_AddObjectToObject(ota, "installed");
  if (!this->ota_run_version_.empty()) cJSON_AddStringToObject(installed, "version", this->ota_run_version_.c_str());
  if (!this->ota_run_sha_.empty()) cJSON_AddStringToObject(installed, "sha256", this->ota_run_sha_.c_str());
  if (!this->ota_run_slot_.empty()) cJSON_AddStringToObject(installed, "slot", this->ota_run_slot_.c_str());

  // A freshly installed image is on probation until the bootloader can no longer
  // roll it back. Only then is a matching image a success worth telling the
  // station about; a crash inside the window still lands on the previous slot.
  if (this->ota_journal_.phase == OTA_J_REBOOTING &&
      ota_hex_matches(std::string(this->ota_journal_.sha256), this->ota_run_sha_) &&
      this->ota_boot_validated_()) {
    this->ota_journal_.phase = OTA_J_REPORT_OK;
    this->ota_journal_save_();
    this->ota_refresh_view_();
  }

  const OtaJournal &j = this->ota_journal_;
  if (j.phase == OTA_J_REPORT_OK || j.phase == OTA_J_REPORT_ROLLED_BACK || j.phase == OTA_J_REPORT_FAILED) {
    if (j.attempt_id[0] == '\0') return;  // nothing to attach a report to
    cJSON *report = cJSON_AddObjectToObject(ota, "report");
    cJSON_AddStringToObject(report, "attemptId", j.attempt_id);
    if (j.phase == OTA_J_REPORT_OK) {
      cJSON_AddStringToObject(report, "phase", "succeeded");
      cJSON_AddStringToObject(report, "bootResult", "ok");
    } else if (j.phase == OTA_J_REPORT_ROLLED_BACK) {
      cJSON_AddStringToObject(report, "phase", "rolled_back");
      cJSON_AddStringToObject(report, "bootResult", "rolled_back");
      cJSON_AddStringToObject(report, "errorCode", "boot_rollback");
      cJSON_AddStringToObject(report, "errorMessage",
                              "The new firmware did not start; the previous image is running.");
    } else {
      cJSON_AddStringToObject(report, "phase", "failed");
      if (j.error_code[0] != '\0') cJSON_AddStringToObject(report, "errorCode", j.error_code);
      if (j.error_message[0] != '\0') cJSON_AddStringToObject(report, "errorMessage", j.error_message);
    }
    // A report and a request are never sent together: once an attempt exists,
    // the station must be told what became of it, not asked for another.
    return;
  }

  if (j.phase == OTA_J_REQUESTED && j.attempt_id[0] == '\0' && j.request_id[0] != '\0' &&
      j.release_id[0] != '\0') {
    cJSON *request = cJSON_AddObjectToObject(ota, "request");
    cJSON_AddStringToObject(request, "requestId", j.request_id);
    cJSON_AddStringToObject(request, "releaseId", j.release_id);
  }
}

void SubwaveDisplay::ota_apply_heartbeat_(cJSON *ota, OtaAttemptInfo *attempt_out, std::string *notice_out) {
  OtaAttemptInfo info;
  std::string notice;
  bool saw_ota = false;

  if (cJSON_IsObject(ota)) {
    saw_ota = true;

    cJSON *a = cJSON_GetObjectItem(ota, "attempt");
    if (cJSON_IsObject(a)) {
      info.id = str_at(a, "id");
      info.state = str_at(a, "state");
      info.release_id = str_at(a, "releaseId");
      info.version = str_at(a, "version");
      info.sha256 = str_at(a, "sha256");
      info.size = static_cast<uint32_t>(std::max(0, int_at(a, "sizeBytes", 0)));
      // The download address is fixed by the contract. An attempt that names
      // any other address is not one this firmware will ever fetch.
      const std::string url = str_at(a, "downloadUrl");
      if (url == OTA_DOWNLOAD_PATH) info.download_url = url;
      if (info.id.empty() || info.state.empty()) info = OtaAttemptInfo{};
    }

    cJSON *pub = cJSON_GetObjectItem(ota, "published");
    if (cJSON_IsObject(pub)) {
      const std::string release_id = str_at(pub, "releaseId");
      const std::string version = str_at(pub, "version");
      const std::string sha = str_at(pub, "sha256");
      const uint32_t size = static_cast<uint32_t>(std::max(0, int_at(pub, "sizeBytes", 0)));
      if (!release_id.empty() && sha.size() == 64) {
        this->ota_note_published_(release_id, version, sha, size);
      } else {
        this->ota_pub_release_id_.clear();
        this->ota_pub_version_.clear();
        this->ota_pub_sha_.clear();
        this->ota_pub_size_ = 0;
      }
    } else {
      this->ota_pub_release_id_.clear();
      this->ota_pub_version_.clear();
      this->ota_pub_sha_.clear();
      this->ota_pub_size_ = 0;
    }

    notice = str_at(ota, "notice");
  }

  if (attempt_out != nullptr) *attempt_out = info;
  if (notice_out != nullptr) *notice_out = notice;

  if (saw_ota && !notice.empty()) {
    if (notice == "installed_not_reported") {
      // Retryable, and deliberately NOT settled: the next heartbeat carries the
      // same report until the station can take it.
      if (this->ota_journal_.phase == OTA_J_REPORT_OK) {
        this->ota_publish_(OtaUiState::Confirming, 100, ota_message_for_notice(notice));
      }
      return;
    }
    if (notice == "stale_report" || notice == "bad_report") {
      if (this->ota_journal_.phase == OTA_J_REPORT_OK || this->ota_journal_.phase == OTA_J_REPORT_ROLLED_BACK ||
          this->ota_journal_.phase == OTA_J_REPORT_FAILED) {
        this->ota_journal_clear_();
      }
    } else if (notice == "success_mismatch") {
      // The station recorded a success against an image this screen is not
      // running. There is nothing left to report and nothing to retry silently.
      this->ota_journal_clear_();
      this->ota_attempt_ = info;
      this->ota_failed_release_id_ = this->ota_pub_release_id_;
      this->ota_publish_(OtaUiState::Failed, 0, ota_message_for_notice(notice));
      return;
    } else if (notice == "device_revoked") {
      this->ota_journal_clear_();
    } else if (notice == "already_in_progress" && ota_state_is_downloadable(info.state) &&
               this->ota_journal_.release_id[0] != '\0' &&
               info.release_id == std::string(this->ota_journal_.release_id)) {
      // The station already holds a live attempt for exactly the release this
      // screen asked for — the answer to an earlier tap was lost, or a second
      // request arrived while one was running. Adopt it, below, instead of
      // reporting a failure: the operator did ask for this update, and a
      // refusal here would leave the row dead until the attempt expired.
      //
      // A live attempt for a DIFFERENT release is not adopted: continuing with
      // it would install an image nobody at this screen chose.
    } else if (this->ota_journal_.phase == OTA_J_REQUESTED) {
      // A refusal of the request itself: there is no attempt to report, only
      // something to say. A changed publication is not a failure of the new
      // release, so it must not be remembered as one.
      if (notice == "bad_request" || notice == "request_rejected") {
        this->ota_failed_release_id_ = this->ota_pub_release_id_;
      }
      this->ota_journal_clear_();
      this->ota_attempt_ = info;
      this->ota_publish_(OtaUiState::Failed, 0, ota_message_for_notice(notice));
      return;
    }
    // Any other notice describes an attempt that is still moving; fall through
    // so the row is not left showing a stale sentence.
  }

  this->ota_attempt_ = info;
  const uint8_t phase = this->ota_journal_.phase;

  if (saw_ota && info.id.empty()) {
    if (phase == OTA_J_DOWNLOADING || phase == OTA_J_VERIFYING || phase == OTA_J_INSTALLING) {
      // The station reaped, cancelled or superseded the attempt. There is
      // nothing left to resume and nothing to report.
      //
      // ONLY WHEN THE STATION ACTUALLY SAID SO. A heartbeat that failed to
      // produce an `ota` block (a database error behind the API, a proxy that
      // dropped the key) is not evidence that the attempt is gone, and treating
      // it as evidence used to fail a perfectly live install.
      this->ota_fail_("The station no longer has this install.", "attempt_lost");
      return;
    }
  } else if (ota_state_is_downloadable(info.state)) {
    if (phase == OTA_J_REQUESTED || phase == OTA_J_DOWNLOADING || phase == OTA_J_VERIFYING ||
        phase == OTA_J_INSTALLING) {
      ota_set_field(this->ota_journal_.attempt_id, sizeof(this->ota_journal_.attempt_id), info.id);
      if (!info.release_id.empty()) {
        ota_set_field(this->ota_journal_.release_id, sizeof(this->ota_journal_.release_id), info.release_id);
      }
      if (!info.version.empty()) {
        ota_set_field(this->ota_journal_.version, sizeof(this->ota_journal_.version), info.version);
      }
      if (!info.sha256.empty()) {
        ota_set_field(this->ota_journal_.sha256, sizeof(this->ota_journal_.sha256), info.sha256);
      }
      if (info.size > 0) this->ota_journal_.size_bytes = info.size;
      if (phase == OTA_J_REQUESTED) this->ota_journal_.phase = OTA_J_DOWNLOADING;
      this->ota_journal_save_();
    }
  } else if (ota_state_is_terminal(info.state)) {
    if (phase != OTA_J_NONE && phase != OTA_J_REPORT_OK && phase != OTA_J_REPORT_ROLLED_BACK &&
        phase != OTA_J_REPORT_FAILED) {
      // An install was intended, and the station says it has ended. Nothing is
      // owed and nothing can be resumed; show the outcome and let a tap decide.
      this->ota_journal_clear_();
    }
  }

  if (!this->ota_install_running_) this->ota_refresh_view_();
}

bool SubwaveDisplay::ota_read_running_(std::string *version, std::string *sha, std::string *slot) {
  if (version == nullptr || sha == nullptr || slot == nullptr) return false;
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (running == nullptr) return false;

  esp_app_desc_t desc{};
  if (esp_ota_get_partition_description(running, &desc) != ESP_OK) return false;
  version->assign(desc.version, strnlen(desc.version, sizeof(desc.version)));
  slot->assign(running->label);

  // Walk the segment table to find where the image ends. The file the station
  // serves is exactly header + segments + checksum (+ the appended digest); any
  // padding in the partition is not part of it and must not be hashed.
  uint8_t header[24];
  if (esp_partition_read(running, 0, header, sizeof(header)) != ESP_OK) return false;
  if (header[0] != 0xE9) return false;  // ESP_IMAGE_HEADER_MAGIC
  const uint8_t segments = header[1];
  uint32_t pos = sizeof(header);
  for (uint8_t i = 0; i < segments; ++i) {
    uint8_t seg[8];
    if (esp_partition_read(running, pos, seg, sizeof(seg)) != ESP_OK) return false;
    const uint32_t len = static_cast<uint32_t>(seg[4]) | (static_cast<uint32_t>(seg[5]) << 8) |
                         (static_cast<uint32_t>(seg[6]) << 16) | (static_cast<uint32_t>(seg[7]) << 24);
    pos += 8 + ((len + 3u) & ~3u);
    if (pos >= running->size) return false;
  }
  uint32_t image_end = (pos + 16u) & ~15u;  // one past the checksum byte
  if (header[0x17] != 0) image_end += 32;    // the appended SHA-256 is part of the file
  if (image_end == 0 || image_end > running->size) return false;

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  uint8_t buf[4096];
  uint32_t off = 0;
  while (off < image_end) {
    const size_t want = std::min<size_t>(sizeof(buf), image_end - off);
    if (esp_partition_read(running, off, buf, want) != ESP_OK) {
      mbedtls_sha256_free(&ctx);
      return false;
    }
    mbedtls_sha256_update(&ctx, buf, want);
    off += want;
    esphome::App.feed_wdt();
    esphome::yield();
  }
  uint8_t digest[32];
  mbedtls_sha256_finish(&ctx, digest);
  mbedtls_sha256_free(&ctx);
  sha->assign(ota_hex(digest, sizeof(digest)));
  return true;
}

bool SubwaveDisplay::ota_boot_validated_() {
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (running == nullptr) return false;
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (esp_ota_get_state_partition(running, &state) != ESP_OK) {
    // Rollback support is not compiled in, so there is no probation to wait for.
    return true;
  }
  return state != ESP_OTA_IMG_PENDING_VERIFY;
}

void SubwaveDisplay::ota_journal_save_() {
  auto *prefs = esphome::global_preferences;
  if (prefs == nullptr) return;
  auto pref = prefs->make_preference<OtaJournal>(OTA_KEY, true);
  pref.save(&this->ota_journal_);
  prefs->sync();
}

void SubwaveDisplay::ota_journal_load_() {
  OtaJournal stored{};
  auto *prefs = esphome::global_preferences;
  bool loaded = false;
  if (prefs != nullptr) {
    auto pref = prefs->make_preference<OtaJournal>(OTA_KEY, true);
    loaded = pref.load(&stored) && stored.magic == OTA_JOURNAL_MAGIC;
  }
  if (!loaded) {
    memset(&this->ota_journal_, 0, sizeof(this->ota_journal_));
    return;
  }
  // A record from another build could have no terminator in one of its fields.
  stored.attempt_id[sizeof(stored.attempt_id) - 1] = '\0';
  stored.release_id[sizeof(stored.release_id) - 1] = '\0';
  stored.request_id[sizeof(stored.request_id) - 1] = '\0';
  stored.version[sizeof(stored.version) - 1] = '\0';
  stored.sha256[sizeof(stored.sha256) - 1] = '\0';
  stored.error_code[sizeof(stored.error_code) - 1] = '\0';
  stored.error_message[sizeof(stored.error_message) - 1] = '\0';
  this->ota_journal_ = stored;
}

void SubwaveDisplay::ota_journal_clear_() {
  // A zeroed record, not a removed key: preferences have no remove, and magic 0
  // is how a torn or stale record is rejected on the next boot.
  memset(&this->ota_journal_, 0, sizeof(this->ota_journal_));
  this->ota_journal_save_();
}

void SubwaveDisplay::ota_publish_(OtaUiState state, int progress, const std::string &message) {
  if (this->ota_ui_mutex_ == nullptr) return;
  if (xSemaphoreTake(this->ota_ui_mutex_, pdMS_TO_TICKS(20)) != pdTRUE) return;
  this->ota_ui_.state = static_cast<uint8_t>(state);
  this->ota_ui_.progress = std::clamp(progress, 0, 100);
  ota_set_field(this->ota_ui_.published_version, sizeof(this->ota_ui_.published_version), this->ota_pub_version_);
  ota_set_field(this->ota_ui_.installed_version, sizeof(this->ota_ui_.installed_version), this->ota_run_version_);
  ota_set_field(this->ota_ui_.message, sizeof(this->ota_ui_.message), message);
  xSemaphoreGive(this->ota_ui_mutex_);
}

OtaView SubwaveDisplay::ota_view() const {
  OtaView view;
  if (this->ota_ui_mutex_ == nullptr) return view;
  if (xSemaphoreTake(this->ota_ui_mutex_, pdMS_TO_TICKS(20)) != pdTRUE) return view;
  view.state = static_cast<OtaUiState>(this->ota_ui_.state);
  view.progress = this->ota_ui_.progress;
  view.published_version = this->ota_ui_.published_version;
  view.installed_version = this->ota_ui_.installed_version;
  view.message = this->ota_ui_.message;
  xSemaphoreGive(this->ota_ui_mutex_);
  return view;
}

void SubwaveDisplay::ota_note_published_(const std::string &release_id, const std::string &version,
                                         const std::string &sha, uint32_t size) {
  this->ota_pub_release_id_ = release_id;
  this->ota_pub_version_ = version;
  this->ota_pub_sha_ = sha;
  this->ota_pub_size_ = size;
}

void SubwaveDisplay::ota_note_installed_(const std::string &version, const std::string &sha, const std::string &slot) {
  this->ota_run_version_ = version.empty() ? std::string(ESPHOME_PROJECT_VERSION) : version;
  this->ota_run_sha_ = sha;
  this->ota_run_slot_ = slot;
}

void SubwaveDisplay::ota_fail_(const std::string &message, const char *error_code) {
  OtaJournal &j = this->ota_journal_;
  const std::string failed_release =
      j.release_id[0] != '\0' ? std::string(j.release_id)
                              : (!this->ota_attempt_.release_id.empty() ? this->ota_attempt_.release_id
                                                                        : this->ota_pub_release_id_);
  if (j.release_id[0] == '\0') ota_set_field(j.release_id, sizeof(j.release_id), failed_release);
  ota_set_field(j.error_code, sizeof(j.error_code), error_code == nullptr ? "" : error_code);
  ota_set_field(j.error_message, sizeof(j.error_message), message);
  if (j.attempt_id[0] != '\0') {
    j.phase = OTA_J_REPORT_FAILED;
    this->ota_journal_save_();
  } else {
    // Nothing for the station to record: the request never became an attempt.
    // The reason stays on the row, not in a record that will never move.
    this->ota_journal_clear_();
  }
  this->ota_failed_release_id_ = failed_release;
  this->ota_publish_(OtaUiState::Failed, 0, message);
}

void SubwaveDisplay::ota_refresh_view_() {
  if (this->ota_install_running_) return;

  switch (this->ota_journal_.phase) {
    case OTA_J_REQUESTED:
      this->ota_publish_(OtaUiState::Checking, 0, "Contacting the station...");
      return;
    case OTA_J_DOWNLOADING:
      this->ota_publish_(OtaUiState::Downloading, 0, "Downloading firmware...");
      return;
    case OTA_J_VERIFYING:
      this->ota_publish_(OtaUiState::Verifying, 100, "Checking the download...");
      return;
    case OTA_J_INSTALLING:
      this->ota_publish_(OtaUiState::Installing, 100, "Installing the update...");
      return;
    case OTA_J_REBOOTING:
      // Before the restart the old image is still running and the sentence is an
      // instruction. After it, the same phase means "installed, waiting to be
      // sure it stays up" — two different facts, never one message.
      if (ota_hex_matches(std::string(this->ota_journal_.sha256), this->ota_run_sha_)) {
        this->ota_publish_(OtaUiState::Confirming, 100, "Checking that the update stays up...");
      } else {
        this->ota_publish_(OtaUiState::Rebooting, 100, "Restarting...");
      }
      return;
    case OTA_J_REPORT_OK:
      this->ota_publish_(OtaUiState::Confirming, 100, "Waiting for the station to confirm the update.");
      return;
    case OTA_J_REPORT_ROLLED_BACK:
      this->ota_publish_(OtaUiState::Failed, 0, "The new firmware did not start. The previous one is running.");
      return;
    case OTA_J_REPORT_FAILED:
      this->ota_publish_(OtaUiState::Failed, 0,
                         this->ota_journal_.error_message[0] != '\0' ? std::string(this->ota_journal_.error_message)
                                                                     : std::string("The update failed."));
      return;
    default:
      break;
  }

  if (!this->ota_pub_release_id_.empty() && !this->ota_pub_sha_.empty() &&
      !ota_hex_matches(this->ota_pub_sha_, this->ota_run_sha_)) {
    if (this->ota_failed_release_id_ == this->ota_pub_release_id_) {
      this->ota_publish_(OtaUiState::Failed, 0, "The last update failed.");
      return;
    }
    const std::string message = this->ota_pub_version_.empty()
                                    ? std::string("A firmware update is ready to install.")
                                    : ("Firmware " + this->ota_pub_version_ + " is ready to install.");
    this->ota_publish_(OtaUiState::Available, 0, message);
    return;
  }
  this->ota_publish_(OtaUiState::Idle, 0, "Firmware is up to date.");
}

void SubwaveDisplay::ota_init_() {
  if (this->ota_ui_mutex_ == nullptr) this->ota_ui_mutex_ = xSemaphoreCreateMutex();
  this->ota_journal_load_();

  std::string version;
  std::string sha;
  std::string slot;
  if (this->ota_read_running_(&version, &sha, &slot)) {
    this->ota_note_installed_(version, sha, slot);
    ESP_LOGI(TAG, "Running firmware %s from %s (sha %s).", version.c_str(), slot.c_str(), sha.c_str());
  } else {
    this->ota_note_installed_(ESPHOME_PROJECT_VERSION, "", "");
    ESP_LOGW(TAG, "Could not fingerprint the running image; update checks will offer the release again.");
  }

  if (this->ota_boot_reconcile_()) {
    ESP_LOGI(TAG, "OTA journal needs a report (phase %u).", static_cast<unsigned>(this->ota_journal_.phase));
  }
  this->ota_refresh_view_();
}

bool SubwaveDisplay::ota_boot_reconcile_() {
  OtaJournal &j = this->ota_journal_;
  if (j.magic != OTA_JOURNAL_MAGIC || j.phase == OTA_J_NONE) return false;

  switch (j.phase) {
    case OTA_J_REQUESTED:
      // The tap never became an attempt, so there is nothing to report and no
      // id to report it against. The operator taps again.
      this->ota_journal_clear_();
      return false;

    case OTA_J_DOWNLOADING:
    case OTA_J_VERIFYING:
    case OTA_J_INSTALLING: {
      // A reset or power cut in the middle of an install. If the running image
      // is the one being installed, the write finished and this boot is the new
      // image; otherwise the previous image is still what runs.
      if (ota_hex_matches(std::string(j.sha256), this->ota_run_sha_)) {
        if (this->ota_boot_validated_()) {
          j.phase = OTA_J_REPORT_OK;
          this->ota_journal_save_();
          return true;
        }
        // The new image is running but still on probation. Wait for the boot to
        // be declared good before claiming anything; the heartbeat below
        // promotes this once the bootloader stops being able to roll it back.
        j.phase = OTA_J_REBOOTING;
        this->ota_journal_save_();
        return false;
      }
      j.phase = OTA_J_REPORT_FAILED;
      ota_set_field(j.error_code, sizeof(j.error_code), "interrupted");
      ota_set_field(j.error_message, sizeof(j.error_message),
                    "The update was interrupted. The previous firmware is running.");
      this->ota_journal_save_();
      this->ota_failed_release_id_ = std::string(j.release_id);
      return true;
    }

    case OTA_J_REBOOTING:
      // Only written immediately before a restart, so this boot is the answer:
      // the new image started, or the bootloader rolled it back. "Started" is
      // not the same as "worked" until the boot is past its probation, so a
      // matching image waits here rather than reporting success early.
      if (ota_hex_matches(std::string(j.sha256), this->ota_run_sha_)) {
        if (this->ota_boot_validated_()) {
          j.phase = OTA_J_REPORT_OK;
          this->ota_journal_save_();
          return true;
        }
        return false;
      }
      j.phase = OTA_J_REPORT_ROLLED_BACK;
      ota_set_field(j.error_message, sizeof(j.error_message),
                    "The new firmware did not start. The previous one is running.");
      this->ota_journal_save_();
      this->ota_failed_release_id_ = std::string(j.release_id);
      return true;

    default:
      // REPORT_* phases are still owed a heartbeat.
      return true;
  }
}

void SubwaveDisplay::ota_resume_() {
  if (this->ota_install_running_) return;
  const uint8_t phase = this->ota_journal_.phase;
  if (phase != OTA_J_DOWNLOADING && phase != OTA_J_VERIFYING && phase != OTA_J_INSTALLING) return;

  if (this->ota_attempt_.id.empty()) {
    this->ota_fail_("The station no longer has this install.", "attempt_lost");
    return;
  }
  if (!ota_state_is_downloadable(this->ota_attempt_.state)) {
    // The attempt ended while this screen was not looking. Nothing to resume;
    // the next tap decides what happens.
    this->ota_journal_clear_();
    this->ota_refresh_view_();
    return;
  }
  if (this->ota_attempt_.download_url.empty()) {
    this->ota_fail_("The station did not offer a download for this install.", "no_url");
    return;
  }
  this->ota_install_();
}

void SubwaveDisplay::ota_begin_request_() {
  OtaJournal &j = this->ota_journal_;
  if (j.request_id[0] == '\0' || j.release_id[0] == '\0') {
    this->ota_fail_("No update was selected.", "no_request");
    return;
  }

  this->ota_publish_(OtaUiState::Checking, 0, "Contacting the station...");
  OtaAttemptInfo info;
  std::string notice;
  const int status = this->send_heartbeat_request_(nullptr, 0, nullptr, &info, &notice);
  if (status != 200) {
    // The request id is already written down. The next heartbeat carries it
    // again, and the station replays rather than creating a second attempt.
    this->ota_publish_(OtaUiState::Checking, 0, "Waiting for the station. It will keep trying.");
    return;
  }

  if (!info.id.empty() && ota_state_is_downloadable(info.state)) {
    this->ota_attempt_ = info;
    ota_set_field(j.attempt_id, sizeof(j.attempt_id), info.id);
    if (!info.release_id.empty()) ota_set_field(j.release_id, sizeof(j.release_id), info.release_id);
    if (!info.version.empty()) ota_set_field(j.version, sizeof(j.version), info.version);
    if (!info.sha256.empty()) ota_set_field(j.sha256, sizeof(j.sha256), info.sha256);
    if (info.size > 0) j.size_bytes = info.size;
    j.phase = OTA_J_DOWNLOADING;
    this->ota_journal_save_();
    this->ota_install_();
    return;
  }

  // A notice means the station answered and refused; ota_apply_heartbeat_ has
  // already replaced the row with the reason.
  if (!notice.empty()) return;
  this->ota_publish_(OtaUiState::Checking, 0, "Waiting for the station.");
}

void SubwaveDisplay::ota_handle_tap_() {
  if (this->ota_install_running_) return;

  // 1. Anything owed to the station is settled first. Starting a second request
  //    while a failed report is still pending would let the next heartbeat
  //    replay the old outcome over the new attempt.
  if (this->ota_journal_.phase == OTA_J_REPORT_OK || this->ota_journal_.phase == OTA_J_REPORT_ROLLED_BACK ||
      this->ota_journal_.phase == OTA_J_REPORT_FAILED) {
    OtaAttemptInfo info;
    std::string notice;
    const int status = this->send_heartbeat_request_(nullptr, 0, nullptr, &info, &notice);
    if (status != 200) {
      this->ota_publish_(OtaUiState::Failed, 0, "Could not reach the station. Tap to try again.");
      return;
    }
    if (this->ota_journal_.phase == OTA_J_REPORT_OK && this->ota_run_sha_.empty()) {
      // A success report is only accepted with the running image's hash as
      // evidence, and this boot could not read one. The report would stay owed
      // for ever and every later tap would be a silent no-op, so give up the
      // claim honestly instead.
      this->ota_journal_clear_();
      this->ota_publish_(OtaUiState::Failed, 0, "This screen could not verify the update.");
      return;
    }
    if (this->ota_journal_.phase == OTA_J_REPORT_OK || this->ota_journal_.phase == OTA_J_REPORT_ROLLED_BACK ||
        this->ota_journal_.phase == OTA_J_REPORT_FAILED) {
      // Still owed (the station could not take it yet). Do not start another.
      return;
    }
  }

  // 2. A request that never got an answer is retried with the same id, so one
  //    tap can never become two attempts.
  if (this->ota_journal_.phase == OTA_J_REQUESTED) {
    this->ota_begin_request_();
    return;
  }

  // 3. An install that stopped mid-flight (power loss, dropped connection)
  //    resumes against the attempt the station still holds.
  if (this->ota_journal_.phase == OTA_J_DOWNLOADING || this->ota_journal_.phase == OTA_J_VERIFYING ||
      this->ota_journal_.phase == OTA_J_INSTALLING) {
    if (this->ota_attempt_.id.empty()) {
      OtaAttemptInfo info;
      std::string notice;
      if (this->send_heartbeat_request_(nullptr, 0, nullptr, &info, &notice) != 200) {
        this->ota_publish_(OtaUiState::Failed, 0, "Could not reach the station. Tap to try again.");
        return;
      }
    }
    this->ota_resume_();
    return;
  }

  // 4. A terminal attempt is finished business: forget it and ask for a new one.
  if (!this->ota_attempt_.id.empty() && ota_state_is_terminal(this->ota_attempt_.state)) {
    this->ota_attempt_ = OtaAttemptInfo{};
    this->ota_journal_clear_();
  }

  // 5. An attempt the station has already accepted, with a recorded intent to
  //    install it, is resumed rather than re-requested.
  if (!this->ota_attempt_.id.empty() && ota_state_is_downloadable(this->ota_attempt_.state) &&
      this->ota_journal_.phase != OTA_J_NONE) {
    this->ota_resume_();
    return;
  }

  // 6. Nothing newer than what is running: say so and do nothing.
  if (this->ota_pub_release_id_.empty() || this->ota_pub_sha_.empty()) {
    this->ota_publish_(OtaUiState::Idle, 0, "No firmware update is published.");
    return;
  }
  if (ota_hex_matches(this->ota_pub_sha_, this->ota_run_sha_)) {
    this->ota_publish_(OtaUiState::Idle, 0, "Firmware is up to date.");
    return;
  }

  // 7. Start a fresh attempt: one request id, written down before it is sent.
  this->ota_attempt_ = OtaAttemptInfo{};
  this->ota_failed_release_id_.clear();
  OtaJournal &j = this->ota_journal_;
  memset(&j, 0, sizeof(j));
  j.magic = OTA_JOURNAL_MAGIC;
  j.phase = OTA_J_REQUESTED;
  ota_set_field(j.request_id, sizeof(j.request_id), ota_new_request_id());
  ota_set_field(j.release_id, sizeof(j.release_id), this->ota_pub_release_id_);
  ota_set_field(j.version, sizeof(j.version), this->ota_pub_version_);
  ota_set_field(j.sha256, sizeof(j.sha256), this->ota_pub_sha_);
  j.size_bytes = this->ota_pub_size_;
  this->ota_journal_save_();
  this->ota_begin_request_();
}

bool SubwaveDisplay::ota_install_() {
  if (this->ota_install_running_) return false;
  if (this->ota_attempt_.id.empty()) {
    this->ota_fail_("No install is reserved for this screen.", "no_attempt");
    return false;
  }
  if (this->ota_attempt_.download_url != OTA_DOWNLOAD_PATH) {
    // The address is fixed by the contract: bearer token, no query, no choice
    // of release. A response naming anything else is not followed.
    this->ota_fail_("The station offered an unexpected download address.", "bad_url");
    return false;
  }
  const uint32_t expected = this->ota_attempt_.size;
  if (expected < OTA_MIN_BYTES || expected > OTA_MAX_BYTES) {
    this->ota_fail_("The published image is not a size this screen can install.", "bad_size");
    return false;
  }
  auto *client = this->http();
  if (client == nullptr) {
    this->ota_fail_("The network is not ready. Tap again when it is.", "no_http");
    return false;
  }

  this->ota_install_running_ = true;
  struct RunningGuard {
    bool *flag;
    ~RunningGuard() { *flag = false; }
  } guard{&this->ota_install_running_};

  OtaJournal &j = this->ota_journal_;
  ota_set_field(j.attempt_id, sizeof(j.attempt_id), this->ota_attempt_.id);
  ota_set_field(j.release_id, sizeof(j.release_id), this->ota_attempt_.release_id);
  ota_set_field(j.version, sizeof(j.version), this->ota_attempt_.version);
  ota_set_field(j.sha256, sizeof(j.sha256), this->ota_attempt_.sha256);
  ota_set_field(j.error_code, sizeof(j.error_code), "");
  ota_set_field(j.error_message, sizeof(j.error_message), "");
  j.size_bytes = expected;
  j.phase = OTA_J_DOWNLOADING;
  this->ota_journal_save_();
  this->ota_publish_(OtaUiState::Downloading, 0, "Downloading firmware...");

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) headers.push_back({"Authorization", "Bearer " + this->bearer_});
  headers.push_back({"Accept", "application/octet-stream"});

  auto container = client->start(join(this->api_base_, OTA_DOWNLOAD_PATH), "GET", "", headers);
  if (container == nullptr) {
    this->ota_fail_("Could not reach the station. Tap to retry.", "offline");
    return false;
  }

  const int status = container->status_code;
  if (status != 200) {
    container->end();
    char buf[96];
    if (status == 401) {
      this->ota_fail_("This screen is no longer recognised by the station.", "unauthorized");
    } else if (status == 409) {
      this->ota_fail_("The station has no live install for this screen.", "no_live_attempt");
    } else if (status == 410) {
      this->ota_fail_("The published image is no longer available.", "artifact_missing");
    } else {
      snprintf(buf, sizeof(buf), "The station refused the download (HTTP %d).", status);
      this->ota_fail_(buf, "download_refused");
    }
    return false;
  }
  if (container->content_length != 0 && container->content_length != expected) {
    container->end();
    this->ota_fail_("The station offered a different image size.", "size_mismatch");
    return false;
  }

  const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
  const esp_partition_t *running = esp_ota_get_running_partition();
  if (slot == nullptr || slot == running) {
    container->end();
    this->ota_fail_("There is no second slot to write the update into.", "no_slot");
    return false;
  }

  // STAGED FIRST, WRITTEN SECOND. Every flash write suspends the external-memory
  // cache, and the panel is scanned out of PSRAM, so a write during the download
  // shows on the glass as a band of garbage every eight kilobytes. Staging the
  // whole image here means the download touches no flash at all: the progress
  // bar moves on a quiet screen, and the write that follows happens behind a
  // dark one (see ui_ota_screen_on). If PSRAM cannot hold the image the old
  // streaming path is kept, flicker and all, because a failed allocation is not
  // a reason to refuse an update this slot could still take.
  std::unique_ptr<uint8_t, void (*)(void *)> staged(
      static_cast<uint8_t *>(heap_caps_malloc(expected, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)), heap_caps_free);
  const bool stage_in_ram = staged != nullptr;
  if (!stage_in_ram) {
    ESP_LOGW(TAG, "No %u-byte PSRAM buffer for the update; streaming it to flash instead.",
             static_cast<unsigned>(expected));
  }

  esp_ota_handle_t handle = 0;
  if (!stage_in_ram && esp_ota_begin(slot, expected, &handle) != ESP_OK) {
    container->end();
    this->ota_fail_("The update slot could not be opened.", "ota_begin");
    return false;
  }

  mbedtls_sha256_context sha_ctx;
  mbedtls_sha256_init(&sha_ctx);
  mbedtls_sha256_starts(&sha_ctx, 0);

  uint8_t chunk[2048];
  uint32_t last_data_time = esphome::millis();
  size_t received = 0;
  int last_pct = -1;
  const char *stop_reason = nullptr;
  while (true) {
    const int n = container->read(chunk, sizeof(chunk));
    esphome::App.feed_wdt();
    esphome::yield();
    const auto loop_res = esphome::http_request::http_read_loop_result(
        n, last_data_time, 30000, container->is_read_complete());
    if (loop_res == esphome::http_request::HttpReadLoopResult::DATA) {
      const size_t previous = received;
      received += static_cast<size_t>(n);
      if (received > static_cast<size_t>(expected)) {
        stop_reason = "The download was longer than the published image.";
        break;
      }
      if (stage_in_ram) {
        memcpy(staged.get() + previous, chunk, static_cast<size_t>(n));
      } else if (esp_ota_write(handle, chunk, static_cast<size_t>(n)) != ESP_OK) {
        stop_reason = "Writing the update failed.";
        break;
      }
      mbedtls_sha256_update(&sha_ctx, chunk, static_cast<size_t>(n));
      const int pct = static_cast<int>((received * 100u) / expected);
      if (pct != last_pct) {
        last_pct = pct;
        this->ota_publish_(OtaUiState::Downloading, pct, "Downloading firmware...");
      }
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::RETRY) continue;
    if (loop_res == esphome::http_request::HttpReadLoopResult::TIMEOUT) {
      stop_reason = "The download timed out. Tap to retry.";
      break;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::ERROR) {
      stop_reason = "The connection dropped. Tap to retry.";
      break;
    }
    break;  // COMPLETE
  }
  container->end();

  if (stop_reason != nullptr) {
    // A staged download never opened the slot, so there is nothing to abort.
    if (!stage_in_ram) esp_ota_abort(handle);
    mbedtls_sha256_free(&sha_ctx);
    this->ota_fail_(stop_reason, "download_failed");
    return false;
  }
  if (received != static_cast<size_t>(expected)) {
    if (!stage_in_ram) esp_ota_abort(handle);
    mbedtls_sha256_free(&sha_ctx);
    this->ota_fail_("The download stopped early. Tap to retry.", "short_read");
    return false;
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha_ctx, digest);
  mbedtls_sha256_free(&sha_ctx);
  const std::string got = ota_hex(digest, sizeof(digest));
  this->ota_publish_(OtaUiState::Verifying, 100, "Checking the download...");
  if (!ota_hex_matches(this->ota_attempt_.sha256, got)) {
    if (!stage_in_ram) esp_ota_abort(handle);
    this->ota_fail_("The download did not match the published checksum.", "checksum");
    return false;
  }

  j.phase = OTA_J_INSTALLING;
  this->ota_journal_save_();
  this->ota_publish_(OtaUiState::Installing, 100, "Installing the update...");

  if (stage_in_ram) {
    // The bytes are here and they are the bytes the station published. From
    // this point the only work left is flash, and flash cannot be shown: each
    // write suspends the cache the panel scans out of. Let the tick paint the
    // sentence, then take the screen and write behind it. The erase happens
    // inside esp_ota_begin, after the screen is dark, which is also why the
    // download no longer starts with a multi-second stall at zero percent.
    esphome::delay(1500);
    ui_ota_screen_on(false);
    for (int waited = 0; waited < 40 && !ui_ota_screen_is_off(); waited++) {
      esphome::delay(50);
    }
    if (!ui_ota_screen_is_off()) {
      ESP_LOGW(TAG, "The screen did not go dark; this install will be visible.");
    }
    // The applied flag means the fade has started, not finished. Wait it out so
    // the first write happens on a screen that is already black.
    esphome::delay(400);

    if (esp_ota_begin(slot, expected, &handle) != ESP_OK) {
      ui_ota_screen_on(true);
      this->ota_fail_("The update slot could not be opened.", "ota_begin");
      return false;
    }

    // 8192 is the flash driver's own write chunk, so each piece is one
    // cache-suspended window rather than four. The piece has to be in DRAM:
    // with the cache suspended a PSRAM source is unreadable and the driver
    // degrades to 32-byte copies with a toggle for each.
    constexpr size_t kPiece = 8192;
    uint8_t stack_piece[2048];
    uint8_t *bounce = static_cast<uint8_t *>(heap_caps_malloc(kPiece, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    uint8_t *buffer = bounce != nullptr ? bounce : stack_piece;
    const size_t piece = bounce != nullptr ? kPiece : sizeof(stack_piece);
    bool written = true;
    size_t offset = 0;
    while (offset < static_cast<size_t>(expected)) {
      const size_t n = std::min(piece, static_cast<size_t>(expected) - offset);
      memcpy(buffer, staged.get() + offset, n);
      if (esp_ota_write(handle, buffer, n) != ESP_OK) {
        written = false;
        break;
      }
      offset += n;
      esphome::App.feed_wdt();
      esphome::yield();
    }
    if (bounce != nullptr) heap_caps_free(bounce);
    if (!written) {
      esp_ota_abort(handle);
      ui_ota_screen_on(true);
      this->ota_fail_("The update could not be written to flash. Tap to retry.", "staged_write");
      return false;
    }
    staged.reset();
  }

  if (esp_ota_end(handle) != ESP_OK) {
    ui_ota_screen_on(true);
    this->ota_fail_("The image was rejected. The previous firmware is intact.", "image_rejected");
    return false;
  }
  if (esp_ota_set_boot_partition(slot) != ESP_OK) {
    ui_ota_screen_on(true);
    this->ota_fail_("The boot slot could not be switched.", "boot_partition");
    return false;
  }

  j.phase = OTA_J_REBOOTING;
  this->ota_journal_save_();
  this->ota_publish_(OtaUiState::Rebooting, 100, "Restarting with the new firmware...");
  ESP_LOGI(TAG, "Firmware %s verified (%u bytes) and written to %s; restarting.", this->ota_attempt_.version.c_str(),
           static_cast<unsigned>(received), slot->label);
  // On a staged install the screen is already dark, so this pause only has to
  // cover the reboot; the light comes back with the new firmware, whose light
  // has restore_mode ALWAYS_ON.
  esphome::delay(1200);
  esp_restart();
  return true;
}

void SubwaveDisplay::request_firmware_update() {
  // The tap is deliberate and the install is explicit. A second tap while one
  // is running is dropped rather than queued, so two taps cannot start two
  // downloads; the snapshot is the mutex-protected copy, not a worker flag.
  const OtaView view = this->ota_view();
  if (view.state == OtaUiState::Checking || view.state == OtaUiState::Downloading ||
      view.state == OtaUiState::Verifying || view.state == OtaUiState::Installing ||
      view.state == OtaUiState::Rebooting) {
    return;
  }
  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::OTA_INSTALL;
  this->enqueue_command_(cmd);
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

void SubwaveDisplay::bind_modal_avatar_image(esphome::runtime_image::RuntimeImage *modal_avatar) {
  this->modal_avatar_image_ = modal_avatar;
}

void SubwaveDisplay::bind_secondary_avatar_images(
    esphome::runtime_image::RuntimeImage *now_avatar_2,
    esphome::runtime_image::RuntimeImage *row_0,
    esphome::runtime_image::RuntimeImage *row_1,
    esphome::runtime_image::RuntimeImage *row_2,
    esphome::runtime_image::RuntimeImage *row_3,
    esphome::runtime_image::RuntimeImage *row_4) {
  this->now_avatar_2_image_ = now_avatar_2;
  this->row_avatar2_images_[0] = row_0;
  this->row_avatar2_images_[1] = row_1;
  this->row_avatar2_images_[2] = row_2;
  this->row_avatar2_images_[3] = row_3;
  this->row_avatar2_images_[4] = row_4;
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
  this->clear_avatar_cache();
  ESP_LOGI(TAG, "Identity dropped (%s); avatar cache cleared (%u entries, %u KB).",
           why, (unsigned) this->avatar_cache_count(), (unsigned) this->avatar_cache_kb());
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

namespace {
// One place decides how a device avatar URL asks for a bigger portrait, so the
// request and the "have I already got this one?" comparison cannot drift apart.
std::string sized_url(const std::string &url, int size) {
  if (url.empty()) return {};
  return url + (url.find('?') != std::string::npos ? "&size=" : "?size=") + std::to_string(size);
}
}  // namespace

void SubwaveDisplay::open_presenter_modal_for_now() {
  this->open_presenter_modal_for_now_at(0);
}

void SubwaveDisplay::open_presenter_modal_for_now_at(size_t start_index) {
  this->presenter_modal_state_.open = true;
  this->presenter_modal_state_.presenters.clear();
  this->presenter_modal_state_.current_index = 0;

  if (!this->byline_.presenters.empty()) {
    this->presenter_modal_state_.presenters = this->byline_.presenters;
  } else {
    PresenterInfo p;
    p.name = this->byline_.presenter.empty() ? (this->station_name_.empty() ? "Subwave Radio" : this->station_name_) : this->byline_.presenter;
    p.role = "Host";
    p.tagline = this->byline_.tagline;
    p.avatar_url = this->byline_.avatar_url.empty() ? this->shown_now_avatar_url_ : this->byline_.avatar_url;
    this->presenter_modal_state_.presenters.push_back(p);
  }

  this->show_presenter_in_modal(
      start_index < this->presenter_modal_state_.presenters.size() ? start_index : 0);
}

void SubwaveDisplay::open_presenter_modal_for_slot(int slot_index) {
  this->open_presenter_modal_for_slot_at(slot_index, 0);
}

void SubwaveDisplay::open_presenter_modal_for_slot_at(int slot_index, size_t start_index) {
  if (slot_index < 0 || slot_index >= (int) this->schedule_slots_.size() || slot_index >= MAX_SCHEDULE_SLOTS) {
    return;
  }

  const auto &slot = this->schedule_slots_[slot_index];
  this->presenter_modal_state_.open = true;
  this->presenter_modal_state_.presenters.clear();
  this->presenter_modal_state_.current_index = 0;

  if (!slot.presenters.empty()) {
    this->presenter_modal_state_.presenters = slot.presenters;
  } else {
    PresenterInfo p;
    p.name = slot.host.empty() ? slot.name : slot.host;
    if (p.name.empty()) p.name = "Presenter";
    p.role = "Host";
    p.tagline = slot.tagline;
    p.avatar_url = slot.avatar_url.empty() ? this->shown_row_avatar_url_[slot_index] : slot.avatar_url;
    this->presenter_modal_state_.presenters.push_back(p);
  }

  this->show_presenter_in_modal(
      start_index < this->presenter_modal_state_.presenters.size() ? start_index : 0);
}

void SubwaveDisplay::next_presenter_in_modal() {
  if (!this->presenter_modal_state_.open || this->presenter_modal_state_.presenters.empty()) return;
  size_t count = this->presenter_modal_state_.presenters.size();
  size_t next_idx = (this->presenter_modal_state_.current_index + 1) % count;
  this->show_presenter_in_modal(next_idx);
}

void SubwaveDisplay::prev_presenter_in_modal() {
  if (!this->presenter_modal_state_.open || this->presenter_modal_state_.presenters.empty()) return;
  size_t count = this->presenter_modal_state_.presenters.size();
  size_t prev_idx = (this->presenter_modal_state_.current_index + count - 1) % count;
  this->show_presenter_in_modal(prev_idx);
}

void SubwaveDisplay::show_presenter_in_modal(size_t index) {
  if (index >= this->presenter_modal_state_.presenters.size()) return;
  this->presenter_modal_state_.current_index = index;

  const auto &p = this->presenter_modal_state_.presenters[index];
  this->presenter_modal_state_.name = p.name;
  this->presenter_modal_state_.role = p.role.empty() ? "Host" : p.role;
  this->presenter_modal_state_.tagline = p.tagline;
  this->presenter_modal_state_.avatar_url = p.avatar_url;

  // The only acceptable placeholder is a 280x280 portrait for this exact URL.
  // The 88px byline thumbnail was being scaled 3.2x into the 280 well, which is
  // the blocky, wrong-looking face the modal opened with.
  esphome::runtime_image::RuntimeImage *placeholder = nullptr;
  const std::string expected_280 = sized_url(p.avatar_url, 280);
  if (this->modal_avatar_image_ != nullptr && !expected_280.empty() &&
      this->shown_modal_avatar_url_ == expected_280 && this->modal_avatar_image_->get_width() > 0) {
    placeholder = this->modal_avatar_image_;
  }

  presenter_modal_show(this->presenter_modal_state_.name.c_str(),
                       this->presenter_modal_state_.role.c_str(),
                       this->presenter_modal_state_.tagline.c_str(),
                       placeholder,
                       index,
                       this->presenter_modal_state_.presenters.size());

  // A different presenter means a different URL, so any backoff applies to the
  // old one and must not delay this face.
  if (expected_280 != this->modal_avatar_requested_url_) {
    this->modal_avatar_retry_ms_ = 0;
  }
  this->ensure_modal_avatar_();
}

void SubwaveDisplay::ensure_modal_avatar_() {
  if (this->modal_avatar_image_ == nullptr) return;
  const std::string expected = sized_url(this->presenter_modal_state_.avatar_url, 280);
  if (expected.empty() || expected == this->shown_modal_avatar_url_ ||
      expected == this->modal_avatar_requested_url_) {
    return;
  }
  if (this->modal_avatar_retry_ms_ != 0 &&
      static_cast<int32_t>(esphome::millis() - this->modal_avatar_retry_ms_) < 0) {
    return;
  }

  WorkerCommand cmd{};
  cmd.type = WorkerCmdType::FETCH_PNG;
  strncpy(cmd.url_or_path, expected.c_str(), sizeof(cmd.url_or_path) - 1);
  cmd.url_or_path[sizeof(cmd.url_or_path) - 1] = '\0';
  cmd.target_ptr = this->modal_avatar_image_;
  cmd.slot_index = -3;
  // Record the URL only once the worker owns the request. If the queue was
  // full, nothing was fetched, so nothing may look fetched.
  if (this->enqueue_command_(cmd)) {
    this->modal_avatar_requested_url_ = expected;
  } else {
    this->modal_avatar_retry_ms_ = esphome::millis() + 3000;
  }
}

void SubwaveDisplay::close_presenter_modal() {
  this->presenter_modal_state_.open = false;
  presenter_modal_dismiss();
}

// ---------------------------------------------------------------------------
// PSRAM Avatar Cache Implementation
// ---------------------------------------------------------------------------

namespace {
// Cache buffers are allocated with heap_caps_malloc, so the shared_ptr's default
// delete[] would be wrong.
struct PsramFree {
  void operator()(uint8_t *p) const {
    if (p != nullptr)
      heap_caps_free(p);
  }
};
}  // namespace

SubwaveDisplay::SubwaveDisplay() {
  this->cache_mutex_ = xSemaphoreCreateMutex();
}

SubwaveDisplay::~SubwaveDisplay() {
  this->clear_avatar_cache();
  if (this->cache_mutex_ != nullptr) {
    vSemaphoreDelete(this->cache_mutex_);
    this->cache_mutex_ = nullptr;
  }
  if (this->ota_ui_mutex_ != nullptr) {
    vSemaphoreDelete(this->ota_ui_mutex_);
    this->ota_ui_mutex_ = nullptr;
  }
}

size_t SubwaveDisplay::avatar_cache_count() const { return this->avatar_cache_count_.load(); }

size_t SubwaveDisplay::avatar_cache_kb() const { return this->avatar_cache_bytes_.load() / 1024; }

void SubwaveDisplay::clear_avatar_cache() {
  if (this->cache_mutex_ == nullptr) {
    this->cache_mutex_ = xSemaphoreCreateMutex();
  }

  if (this->cache_mutex_ != nullptr) {
    if (xSemaphoreTake(this->cache_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
      // Dropping the map releases the shared_ptr handles. A buffer being decoded
      // on the worker stays alive until that decode finishes.
      this->avatar_cache_.clear();
      this->avatar_cache_count_.store(0);
      this->avatar_cache_bytes_.store(0);
      xSemaphoreGive(this->cache_mutex_);
    } else {
      ESP_LOGW(TAG, "clear_avatar_cache: timeout waiting for cache_mutex_");
      return;
    }
  } else {
    this->avatar_cache_.clear();
    this->avatar_cache_count_.store(0);
    this->avatar_cache_bytes_.store(0);
  }

  // Clear tracking URLs to force re-fetch on demand across all avatar sizes
  this->shown_now_avatar_url_.clear();
  this->pending_now_avatar_url_.clear();
  this->shown_now_avatar_2_url_.clear();
  this->pending_now_avatar_2_url_.clear();
  this->modal_avatar_requested_url_.clear();
  this->shown_modal_avatar_url_.clear();
  for (int i = 0; i < MAX_SCHEDULE_SLOTS; ++i) {
    this->shown_row_avatar_url_[i].clear();
    this->pending_row_avatar_url_[i].clear();
    this->shown_row_avatar2_url_[i].clear();
    this->pending_row_avatar2_url_[i].clear();
  }

  ESP_LOGI(TAG, "Avatar cache cleared: PSRAM buffers freed, URLs reset.");
}

bool SubwaveDisplay::fetch_png_cached_(const std::string &path, esphome::runtime_image::RuntimeImage *img) {
  ScopedTimer timer("subwave.block", "fetch_png_cached", 100);
  if (path.empty() || img == nullptr) return false;

  const std::string url =
      (path.rfind("http://", 0) == 0 || path.rfind("https://", 0) == 0) ? path : join(this->api_base_, path);

  // 1. Check PSRAM cache under FreeRTOS Mutex
  if (this->cache_mutex_ == nullptr) {
    this->cache_mutex_ = xSemaphoreCreateMutex();
  }

  std::shared_ptr<uint8_t> cached_data;
  size_t cached_len = 0;
  uint32_t cached_age_ms = 0;
  if (this->cache_mutex_ != nullptr && xSemaphoreTake(this->cache_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    auto it = this->avatar_cache_.find(url);
    if (it != this->avatar_cache_.end()) {
      uint32_t age_ms = esphome::millis() - it->second.timestamp_ms;
      if (age_ms < AVATAR_CACHE_TTL_MS && it->second.data != nullptr && it->second.length > 0) {
        cached_data = it->second.data;
        cached_len = it->second.length;
        cached_age_ms = age_ms;
      }
    }
    xSemaphoreGive(this->cache_mutex_);
  }

  // Decode OUTSIDE the lock. The copied handle keeps the buffer alive even if
  // clear_avatar_cache() drops the map entry while this decode is running.
  if (cached_data != nullptr && cached_len > 0) {
    img->release();
    if (img->begin_decode(cached_len)) {
      int consumed = img->feed_data(cached_data.get(), cached_len);
      img->end_decode();
      if (consumed >= 0 && img->get_width() > 0 && img->get_height() > 0) {
        ESP_LOGI(TAG, "Served avatar %s from PSRAM cache (%u bytes -> %dx%d, age %u s).",
                 path.c_str(), (unsigned) cached_len, img->get_width(), img->get_height(),
                 (unsigned) (cached_age_ms / 1000U));
        return true;
      }
    }
  }

  // 2. Cache Miss or Expired (>24h): Network HTTP Fetch
  auto *client = this->http();
  if (client == nullptr) return false;

  std::vector<esphome::http_request::Header> headers;
  if (!this->bearer_.empty()) {
    headers.push_back({"Authorization", "Bearer " + this->bearer_});
  }
  headers.push_back({"Accept", "image/png,image/jpeg,*/*;q=0.8"});

  auto container = client->start(url, "GET", "", headers);
  if (container == nullptr) {
    ESP_LOGW(TAG, "GET %s could not be started.", path.c_str());
    return false;
  }
  int status = container->status_code;
  if (status != 200) {
    ESP_LOGW(TAG, "Avatar %s returned status %d.", path.c_str(), status);
    container->end();
    return false;
  }

  constexpr size_t MAX_AVATAR_BODY = 512 * 1024;  // 512 KB safety cap
  std::vector<uint8_t> body;
  if (container->content_length > 0 && container->content_length <= MAX_AVATAR_BODY) {
    body.reserve(container->content_length);
  }

  uint8_t chunk[512];
  uint32_t last_data_time = esphome::millis();
  while (true) {
    int n = container->read(chunk, sizeof(chunk));
    // Non-blocking streaming read
    auto loop_res = esphome::http_request::http_read_loop_result(
        n, last_data_time, 12000, container->is_read_complete());
    if (loop_res == esphome::http_request::HttpReadLoopResult::DATA) {
      body.insert(body.end(), chunk, chunk + n);
      if (body.size() > MAX_AVATAR_BODY) {
        ESP_LOGW(TAG, "Avatar %s exceeded 512KB cap; discarding.", path.c_str());
        container->end();
        return false;
      }
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::RETRY) {
      continue;
    }
    if (loop_res == esphome::http_request::HttpReadLoopResult::TIMEOUT) {
      ESP_LOGW(TAG, "Avatar %s timed out during download.", path.c_str());
      container->end();
      return false;
    }
    break;
  }
  container->end();

  if (body.empty()) {
    ESP_LOGW(TAG, "Avatar %s returned empty body.", path.c_str());
    return false;
  }

  // 3. PSRAM Buffer Allocation
  size_t len = body.size();
  uint8_t *psram_buf = static_cast<uint8_t *>(heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (psram_buf == nullptr) {
    ESP_LOGE(TAG, "Failed to allocate %u bytes in PSRAM for avatar %s", (unsigned) len, path.c_str());
    // Fallback: stream and decode directly if PSRAM is exhausted
    return this->fetch_image_to_runtime_image_(path, img);
  }

  memcpy(psram_buf, body.data(), len);

  // 4. Decode into RuntimeImage
  img->release();
  if (!img->begin_decode(len)) {
    ESP_LOGW(TAG, "Avatar %s begin_decode failed.", path.c_str());
    heap_caps_free(psram_buf);
    return false;
  }

  int consumed = img->feed_data(psram_buf, len);
  img->end_decode();

  if (consumed < 0 || img->get_width() <= 0 || img->get_height() <= 0) {
    ESP_LOGW(TAG, "Avatar %s decode error (consumed: %d, dims: %dx%d).",
             path.c_str(), consumed, img->get_width(), img->get_height());
    heap_caps_free(psram_buf);
    return false;
  }

  // 5. Store in PSRAM Cache under Mutex. Ownership moves into the shared handle
  // immediately, so every early-out below frees the buffer exactly once.
  std::shared_ptr<uint8_t> cached_buf(psram_buf, PsramFree{});
  if (this->cache_mutex_ != nullptr && xSemaphoreTake(this->cache_mutex_, pdMS_TO_TICKS(100)) == pdTRUE) {
    AvatarCacheEntry entry;
    entry.data = cached_buf;
    entry.length = len;
    entry.timestamp_ms = esphome::millis();
    entry.url = url;
    // Assignment releases the previous entry's handle (and its buffer).
    this->avatar_cache_[url] = entry;

    uint32_t total_bytes = 0;
    for (const auto &pair : this->avatar_cache_)
      total_bytes += pair.second.length;
    this->avatar_cache_bytes_.store(total_bytes);
    this->avatar_cache_count_.store((uint32_t) this->avatar_cache_.size());
    xSemaphoreGive(this->cache_mutex_);

    ESP_LOGI(TAG, "Cached avatar %s in PSRAM (%u bytes -> %dx%d, total cache: %u KB).",
             path.c_str(), (unsigned) len, img->get_width(), img->get_height(),
             (unsigned) (total_bytes / 1024));
  }

  return true;
}

}  // namespace subwave_display
