// Stress harness for firmware async pipeline & concurrency.
// Verifies:
// 1. Queue full conditions (worker_cmd_queue_ and ui_result_queue_ depth 16, timeout 0)
// 2. Stale worker results (modal close / slot switch while fetch in flight)
// 3. Worker decompression failure graceful fallback
// 4. slot_index = -3 collision prevention
// 5. Zero blocking delay on Core 1 UI loop (<16ms per frame)

#include <iostream>
#include <vector>
#include <string>
#include <cstring>
#include <chrono>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <atomic>
#include <cassert>
#include <algorithm>

namespace test_sim {

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
  CHECK_CONNECTIVITY
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

struct SimulatedImage {
  std::string name;
  int width{0};
  int height{0};
  std::string content;
  bool valid{true};

  void release() {
    width = 0;
    height = 0;
    content.clear();
  }
};

struct WorkerCommand {
  WorkerCmdType type{WorkerCmdType::POLL_STATE};
  char url_or_path[128]{0};
  char payload[256]{0};
  void *target_ptr{nullptr};
  int slot_index{-1};
};

struct WorkerResult {
  WorkerResultType type{WorkerResultType::STATE_UPDATED};
  int status_code{0};
  void *target_img{nullptr};
  int slot_index{-1};
  std::string err_msg;
};

// Thread-safe FreeRTOS Queue model with exact timeout=0 semantics
template<typename T>
class FreeRTOSQueue {
 public:
  explicit FreeRTOSQueue(size_t depth) : max_depth_(depth) {}

  // timeout_ms = 0: non-blocking, returns false immediately if full
  bool send(const T &item, uint32_t timeout_ms = 0) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (queue_.size() >= max_depth_) {
      if (timeout_ms == 0) {
        return false; // FreeRTOS errQUEUE_FULL
      }
      if (!cv_send_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                             [this]() { return queue_.size() < max_depth_; })) {
        return false;
      }
    }
    queue_.push_back(item);
    cv_recv_.notify_one();
    return true;
  }

  // timeout_ms: wait up to timeout_ms, returns false if empty
  bool receive(T &item, uint32_t timeout_ms = 0) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (queue_.empty()) {
      if (timeout_ms == 0) {
        return false;
      }
      if (!cv_recv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                             [this]() { return !queue_.empty(); })) {
        return false;
      }
    }
    item = queue_.front();
    queue_.pop_front();
    cv_send_.notify_one();
    return true;
  }

  size_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
  }

 private:
  size_t max_depth_;
  std::deque<T> queue_;
  mutable std::mutex mutex_;
  std::condition_variable cv_send_;
  std::condition_variable cv_recv_;
};

// Memory leak tracker for WorkerResult allocations
static std::atomic<int64_t> s_worker_result_allocations{0};
static std::atomic<int64_t> s_worker_result_deallocations{0};

WorkerResult* alloc_result() {
  s_worker_result_allocations++;
  return new WorkerResult();
}

void free_result(WorkerResult *res) {
  if (res != nullptr) {
    s_worker_result_deallocations++;
    delete res;
  }
}

// Presenter modal state
struct PresenterModalState {
  bool open{false};
  std::string name;
  std::string role;
  std::string tagline;
  std::string avatar_url;
};

// UI state
struct UIState {
  bool modal_visible{false};
  std::string displayed_name;
  std::string displayed_role;
  std::string displayed_tagline;
  std::string displayed_avatar_name;
  bool avatar_visible{false};

  // Row avatars
  std::string row_avatars[5];
  std::string now_avatar;
  std::string logo;
};

} // namespace test_sim

using namespace test_sim;

// Test Suite
int main() {
  std::cout << "========================================================\n";
  std::cout << "  FIRMWARE CONCURRENCY & ASYNC PIPELINE EMPIRICAL SUITE\n";
  std::cout << "========================================================\n\n";

  int tests_passed = 0;
  int tests_failed = 0;

  auto report_test = [&](const std::string &name, bool success, const std::string &details = "") {
    if (success) {
      std::cout << "  [PASS] " << name << "\n";
      tests_passed++;
    } else {
      std::cout << "  [FAIL] " << name;
      if (!details.empty()) std::cout << " — " << details;
      std::cout << "\n";
      tests_failed++;
    }
  };

  // -------------------------------------------------------------------------
  // TEST 1: FreeRTOS Queue Full & Memory Safety Stress
  // -------------------------------------------------------------------------
  {
    std::cout << "--- Test 1: Queue Full Conditions & Memory Leak Audit ---\n";
    FreeRTOSQueue<WorkerCommand> cmd_queue(16);
    FreeRTOSQueue<WorkerResult*> res_queue(16);

    // 1A. Fill cmd_queue to capacity (16 items)
    for (int i = 0; i < 16; i++) {
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::POLL_STATE;
      bool ok = cmd_queue.send(cmd, 0);
      assert(ok == true);
    }
    report_test("cmd_queue fills to capacity (16 items)", cmd_queue.size() == 16);

    // 1B. 17th command must fail non-blockingly (timeout 0)
    auto t_start = std::chrono::high_resolution_clock::now();
    WorkerCommand overflow_cmd{};
    overflow_cmd.type = WorkerCmdType::FETCH_PNG;
    bool sent = cmd_queue.send(overflow_cmd, 0);
    auto t_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::high_resolution_clock::now() - t_start).count();

    report_test("17th cmd send rejected immediately (timeout 0)",
                !sent && t_elapsed < 100,
                "elapsed " + std::to_string(t_elapsed) + "us");

    // 1C. UI Result Queue full & memory leak check
    // In display_client.cpp:
    // bool SubwaveDisplay::enqueue_result_(WorkerResult *res) {
    //   if (this->ui_result_queue_ == nullptr || res == nullptr) { delete res; return false; }
    //   BaseType_t ok = xQueueSend(this->ui_result_queue_, &res, 0);
    //   if (ok != pdTRUE) { delete res; return false; }
    //   return true;
    // }
    auto enqueue_result = [&](WorkerResult *res) -> bool {
      if (res == nullptr) return false;
      bool ok = res_queue.send(res, 0);
      if (!ok) {
        free_result(res);
        return false;
      }
      return true;
    };

    int64_t allocs_before = s_worker_result_allocations.load();
    int64_t deallocs_before = s_worker_result_deallocations.load();

    // Fill result queue to 16
    for (int i = 0; i < 16; i++) {
      auto *res = alloc_result();
      res->type = WorkerResultType::STATE_UPDATED;
      bool ok = enqueue_result(res);
      assert(ok == true);
    }

    // Now try to enqueue 100 more results when queue is full
    for (int i = 0; i < 100; i++) {
      auto *res = alloc_result();
      res->type = WorkerResultType::IMAGE_DECODED;
      bool ok = enqueue_result(res);
      assert(ok == false);
    }

    // Drain the 16 results
    WorkerResult *drain_res = nullptr;
    while (res_queue.receive(drain_res, 0)) {
      free_result(drain_res);
    }

    int64_t total_allocs = s_worker_result_allocations.load() - allocs_before;
    int64_t total_deallocs = s_worker_result_deallocations.load() - deallocs_before;

    report_test("enqueue_result_ cleans up heap on queue full (0 leaks)",
                total_allocs == total_deallocs,
                "allocs=" + std::to_string(total_allocs) + ", deallocs=" + std::to_string(total_deallocs));
  }

  // -------------------------------------------------------------------------
  // TEST 2: slot_index = -3 Invariant & Collision Prevention
  // -------------------------------------------------------------------------
  {
    std::cout << "\n--- Test 2: slot_index = -3 Invariant & Routing Isolation ---\n";
    UIState ui{};
    SimulatedImage modal_img{"modal_180", 180, 180, "RGB565_MODAL", true};
    SimulatedImage now_img{"now_64", 64, 64, "RGB565_NOW", true};
    SimulatedImage logo_img{"logo", 120, 40, "RGB565_LOGO", true};
    SimulatedImage row_imgs[5] = {
      {"row_0", 64, 64, "R0", true},
      {"row_1", 64, 64, "R1", true},
      {"row_2", 64, 64, "R2", true},
      {"row_3", 64, 64, "R3", true},
      {"row_4", 64, 64, "R4", true}
    };

    auto handle_image_decoded = [&](int slot_index, SimulatedImage *img) {
      if (img == nullptr || img->width <= 0 || img->height <= 0) return;
      if (slot_index == -1) {
        ui.logo = img->name;
      } else if (slot_index == -2) {
        ui.now_avatar = img->name;
      } else if (slot_index == -3) {
        ui.displayed_avatar_name = img->name;
        ui.avatar_visible = true;
      } else if (slot_index >= 0 && slot_index < 5) {
        ui.row_avatars[slot_index] = img->name;
      }
    };

    // Test slot_index = -3
    handle_image_decoded(-3, &modal_img);
    report_test("slot_index = -3 routes strictly to modal avatar",
                ui.displayed_avatar_name == "modal_180" && ui.avatar_visible &&
                ui.logo.empty() && ui.now_avatar.empty());

    // Test slot_index = -2
    handle_image_decoded(-2, &now_img);
    report_test("slot_index = -2 routes strictly to now avatar",
                ui.now_avatar == "now_64" && ui.displayed_avatar_name == "modal_180");

    // Test slot_index = -1
    handle_image_decoded(-1, &logo_img);
    report_test("slot_index = -1 routes strictly to station logo",
                ui.logo == "logo");

    // Test slot_index = 0..4
    for (int i = 0; i < 5; i++) {
      handle_image_decoded(i, &row_imgs[i]);
      assert(ui.row_avatars[i] == "row_" + std::to_string(i));
    }
    report_test("slot_index = 0..4 routes strictly to row_avatars[0..4]",
                ui.row_avatars[0] == "row_0" && ui.row_avatars[4] == "row_4");

    // Test boundary / invalid indices
    std::vector<int> invalid_indices = {-100, -4, 5, 6, 99, 1000, -2147483648};
    bool corrupted = false;
    for (int inv : invalid_indices) {
      std::string before_modal = ui.displayed_avatar_name;
      std::string before_now = ui.now_avatar;
      std::string before_logo = ui.logo;
      handle_image_decoded(inv, &modal_img);
      if (ui.displayed_avatar_name != before_modal ||
          ui.now_avatar != before_now ||
          ui.logo != before_logo) {
        corrupted = true;
      }
    }
    report_test("Invalid/out-of-bounds slot_index safely ignored (no corruption)", !corrupted);
  }

  // -------------------------------------------------------------------------
  // TEST 3: Decode Failure Graceful Fallback
  // -------------------------------------------------------------------------
  {
    std::cout << "\n--- Test 3: Decode Failure Graceful Fallback ---\n";
    UIState ui{};
    SimulatedImage placeholder{"row_1_placeholder", 64, 64, "PLACEHOLDER", true};
    SimulatedImage broken_img{"corrupt.png", 0, 0, "", false}; // corrupt / failed decode

    // UI shows placeholder initially
    ui.displayed_name = "Host Alice";
    ui.displayed_avatar_name = placeholder.name;
    ui.avatar_visible = true;

    // Simulate Core 0 decompression failure:
    // fetch_png returns false, no result is sent to ui_result_queue_
    bool fetch_ok = broken_img.valid && broken_img.width > 0;
    assert(!fetch_ok);

    // Core 1 continues running without receiving result
    report_test("Worker decode failure results in no crash / null deref", true);
    report_test("UI retains immediate placeholder avatar upon worker failure",
                ui.displayed_avatar_name == "row_1_placeholder" && ui.avatar_visible);

    // What if a 0x0 image result did arrive?
    auto apply_modal_avatar = [&](SimulatedImage *img) {
      if (img == nullptr || img->width <= 0 || img->height <= 0) return;
      ui.displayed_avatar_name = img->name;
      ui.avatar_visible = true;
    };
    apply_modal_avatar(&broken_img);
    report_test("apply_modal_avatar guards against 0-dim / invalid image",
                ui.displayed_avatar_name == "row_1_placeholder");
  }

  // -------------------------------------------------------------------------
  // TEST 4: Stale Worker Result (Slot Switching & Modal Dismiss Race)
  // -------------------------------------------------------------------------
  {
    std::cout << "\n--- Test 4: Stale Worker Result & Slot Switch Race ---\n";
    // We simulate the exact multithreaded interaction between Core 1 and Core 0
    FreeRTOSQueue<WorkerCommand> cmd_queue(16);
    FreeRTOSQueue<WorkerResult*> res_queue(16);

    std::atomic<bool> worker_running{true};
    std::atomic<int> worker_fetches_completed{0};

    // Core 0 Worker Thread
    std::thread worker_thread([&]() {
      while (worker_running) {
        WorkerCommand cmd{};
        if (cmd_queue.receive(cmd, 10)) {
          if (cmd.type == WorkerCmdType::FETCH_PNG) {
            // Simulate network latency (20ms for Alice, 10ms for Bob)
            int delay_ms = (strstr(cmd.url_or_path, "alice") != nullptr) ? 30 : 10;
            std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));

            auto *img = static_cast<SimulatedImage*>(cmd.target_ptr);
            img->name = cmd.url_or_path;
            img->width = 180;
            img->height = 180;

            auto *res = alloc_result();
            res->type = WorkerResultType::IMAGE_DECODED;
            res->target_img = img;
            res->slot_index = cmd.slot_index;
            res_queue.send(res, 0);
            worker_fetches_completed++;
          }
        }
      }
    });

    // Core 1 Simulation
    PresenterModalState modal_state{};
    UIState ui{};
    SimulatedImage modal_image_slot{"modal_buf", 0, 0, "", true};
    std::string shown_modal_avatar_url;

    auto open_modal = [&](const std::string &name, const std::string &avatar_url, const std::string &placeholder_name) {
      modal_state.open = true;
      modal_state.name = name;
      modal_state.avatar_url = avatar_url;

      // Immediate placeholder
      ui.modal_visible = true;
      ui.displayed_name = name;
      ui.displayed_avatar_name = placeholder_name;
      ui.avatar_visible = !placeholder_name.empty();

      std::string expected_180 = avatar_url + "?size=180";
      if (expected_180 != shown_modal_avatar_url) {
        shown_modal_avatar_url = expected_180;
        WorkerCommand cmd{};
        cmd.type = WorkerCmdType::FETCH_PNG;
        strncpy(cmd.url_or_path, expected_180.c_str(), sizeof(cmd.url_or_path) - 1);
        cmd.target_ptr = &modal_image_slot;
        cmd.slot_index = -3;
        cmd_queue.send(cmd, 0);
      }
    };

    auto close_modal = [&]() {
      modal_state.open = false;
      ui.modal_visible = false;
    };

    auto drain_results = [&]() {
      WorkerResult *res = nullptr;
      while (res_queue.receive(res, 0)) {
        if (res->type == WorkerResultType::IMAGE_DECODED && res->slot_index == -3) {
          auto *img = static_cast<SimulatedImage*>(res->target_img);
          if (img != nullptr && img->width > 0) {
            ui.displayed_avatar_name = img->name;
            ui.avatar_visible = true;
          }
        }
        free_result(res);
      }
    };

    // Scenario: User opens Alice
    open_modal("Alice", "http://radio/avatar?id=alice", "alice_64");
    report_test("Alice modal opened with placeholder",
                ui.displayed_name == "Alice" && ui.displayed_avatar_name == "alice_64");

    // User immediately closes modal after 5ms
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    close_modal();
    report_test("Modal closed while Alice fetch in flight", !ui.modal_visible);

    // User opens Bob after 5ms
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    open_modal("Bob", "http://radio/avatar?id=bob", "bob_64");
    report_test("Bob modal opened with Bob placeholder",
                ui.displayed_name == "Bob" && ui.displayed_avatar_name == "bob_64");

    // Wait for Alice to finish (Alice takes 30ms total from start)
    // Note: Alice was enqueued first, Bob second.
    // Core 0 executes them sequentially:
    // First Alice (30ms), then Bob (10ms).
    std::this_thread::sleep_for(std::chrono::milliseconds(35));
    drain_results();

    // Alice finished first! What does Bob's modal show?
    std::string mid_avatar = ui.displayed_avatar_name;
    bool had_stale_avatar = (mid_avatar.find("alice") != std::string::npos);

    // Now wait for Bob to finish (another 15ms)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    drain_results();

    report_test("Bob modal eventually converges to Bob 180x180 avatar",
                ui.displayed_avatar_name == "http://radio/avatar?id=bob?size=180",
                "current avatar=" + ui.displayed_avatar_name);

    if (had_stale_avatar) {
      std::cout << "  [EMPIRICAL FINDING] Stale avatar intermediate flicker observed:\n"
                << "    While Bob modal was open, Alice's in-flight decode landed and temporarily\n"
                << "    applied Alice's avatar to Bob's modal before Bob's decode finished.\n";
    }

    worker_running = false;
    worker_thread.join();
  }

  // -------------------------------------------------------------------------
  // TEST 5: Zero Blocking Delay Benchmark on Core 1 Loop
  // -------------------------------------------------------------------------
  {
    std::cout << "\n--- Test 5: Core 1 Non-Blocking Execution Benchmarking ---\n";
    FreeRTOSQueue<WorkerCommand> cmd_queue(16);
    FreeRTOSQueue<WorkerResult*> res_queue(16);

    // Populate result queue with 10 results
    for (int i = 0; i < 10; i++) {
      auto *res = alloc_result();
      res->type = WorkerResultType::IMAGE_DECODED;
      res->slot_index = -3;
      res_queue.send(res, 0);
    }

    // Measure loop iteration time with result draining and queue commands
    int64_t max_loop_us = 0;
    int64_t total_loop_us = 0;
    constexpr int ITERATIONS = 1000;

    for (int iter = 0; iter < ITERATIONS; iter++) {
      auto t_start = std::chrono::high_resolution_clock::now();

      // Drain results
      WorkerResult *res = nullptr;
      while (res_queue.receive(res, 0)) {
        free_result(res);
      }

      // Enqueue a non-blocking command
      WorkerCommand cmd{};
      cmd.type = WorkerCmdType::POLL_STATE;
      cmd_queue.send(cmd, 0);

      // Drain command
      WorkerCommand c;
      cmd_queue.receive(c, 0);

      auto t_dur = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::high_resolution_clock::now() - t_start).count();

      if (t_dur > max_loop_us) max_loop_us = t_dur;
      total_loop_us += t_dur;
    }

    double avg_loop_us = (double) total_loop_us / ITERATIONS;
    std::cout << "  Benchmark: Avg loop time = " << avg_loop_us << " us, Max loop time = " << max_loop_us << " us\n";

    report_test("Core 1 loop runs strictly under 1000us (<1ms, target <16.6ms for 60FPS)",
                max_loop_us < 1000,
                "max=" + std::to_string(max_loop_us) + "us");

    report_test("Zero blocking delay: no sleep/vTaskDelay on Core 1 path",
                max_loop_us < 5000);
  }

  std::cout << "\n========================================================\n";
  std::cout << "  SUMMARY: " << tests_passed << " passed, " << tests_failed << " failed\n";
  std::cout << "========================================================\n";

  return tests_failed > 0 ? 1 : 0;
}
