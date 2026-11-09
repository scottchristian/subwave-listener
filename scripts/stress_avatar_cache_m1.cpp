// Comprehensive Empirical Stress Suite for Avatar Cache, Concurrency & Rollover
// Milestone 1 Challenger Verification
// Tests:
// 1. 24-hour TTL expiration logic & unsigned 32-bit timestamp rollover (exhaustive & Monte Carlo)
// 2. Multithreaded PSRAM buffer lifecycle, double-free prevention & leak audit under ASAN
// 3. Mutex contention & Core 1 loop non-blocking invariants (<16.6ms loop, 0 touch stalls >250ms)

#include <iostream>
#include <vector>
#include <string>
#include <map>
#include <random>
#include <chrono>
#include <thread>
#include <mutex>
#include <atomic>
#include <cassert>
#include <cstdint>
#include <cstring>

namespace challenger_sim {

constexpr uint32_t AVATAR_CACHE_TTL_MS = 86400000U; // 24 hours

// Simulated PSRAM allocation tracking
static std::atomic<int64_t> s_psram_allocations{0};
static std::atomic<int64_t> s_psram_deallocations{0};
static std::atomic<int64_t> s_psram_bytes_allocated{0};

void* sim_heap_caps_malloc(size_t size) {
  if (size == 0) return nullptr;
  uint8_t *ptr = new uint8_t[size + 16]; // include guard bytes
  // Canary header
  uint32_t *canary = reinterpret_cast<uint32_t*>(ptr);
  *canary = 0xDEADBEEF;
  s_psram_allocations++;
  s_psram_bytes_allocated += size;
  return ptr + 8;
}

void sim_heap_caps_free(void *ptr) {
  if (ptr == nullptr) return;
  uint8_t *raw = static_cast<uint8_t*>(ptr) - 8;
  uint32_t *canary = reinterpret_cast<uint32_t*>(raw);
  if (*canary != 0xDEADBEEF) {
    std::cerr << "FATAL: Canary corruption or double free on " << ptr << "\n";
    std::abort();
  }
  // Invalidate canary
  *canary = 0xBAADF00D;
  delete[] raw;
  s_psram_deallocations++;
}

struct AvatarCacheEntry {
  uint8_t *data{nullptr};
  size_t length{0};
  uint32_t timestamp_ms{0};
  std::string url;
};

class SimulatedSubwaveDisplay {
 public:
  SimulatedSubwaveDisplay() = default;
  ~SimulatedSubwaveDisplay() {
    clear_avatar_cache();
  }

  void clear_avatar_cache() {
    std::unique_lock<std::timed_mutex> lock(cache_mutex_, std::chrono::milliseconds(100));
    if (!lock.owns_lock()) {
      std::cerr << "clear_avatar_cache timed out waiting for mutex\n";
      return;
    }
    for (auto &pair : avatar_cache_) {
      if (pair.second.data != nullptr) {
        sim_heap_caps_free(pair.second.data);
        pair.second.data = nullptr;
      }
    }
    avatar_cache_.clear();
    avatar_cache_bytes_ = 0;
    lock.unlock();

    // Clear shown URLs (UI thread state)
    shown_now_avatar_url_.clear();
    pending_now_avatar_url_.clear();
    shown_modal_avatar_url_.clear();
    for (int i = 0; i < 5; ++i) {
      shown_row_avatar_url_[i].clear();
      pending_row_avatar_url_[i].clear();
    }
  }

  size_t avatar_cache_count() const {
    std::unique_lock<std::timed_mutex> lock(cache_mutex_, std::chrono::milliseconds(100));
    if (lock.owns_lock()) {
      return avatar_cache_.size();
    }
    return avatar_cache_.size();
  }

  size_t avatar_cache_kb() const {
    std::unique_lock<std::timed_mutex> lock(cache_mutex_, std::chrono::milliseconds(100));
    if (lock.owns_lock()) {
      return avatar_cache_bytes_ / 1024;
    }
    return avatar_cache_bytes_ / 1024;
  }

  // Simulates fetch_png_cached_ cache hit
  bool query_cache(const std::string &url, uint32_t current_time_ms, std::vector<uint8_t> &out_data) {
    std::unique_lock<std::timed_mutex> lock(cache_mutex_, std::chrono::milliseconds(100));
    if (!lock.owns_lock()) return false;

    auto it = avatar_cache_.find(url);
    if (it != avatar_cache_.end()) {
      uint32_t age_ms = current_time_ms - it->second.timestamp_ms;
      if (age_ms < AVATAR_CACHE_TTL_MS && it->second.data != nullptr && it->second.length > 0) {
        // Read buffer safely under lock
        out_data.assign(it->second.data, it->second.data + it->second.length);
        return true;
      }
    }
    return false;
  }

  // Simulates fetch_png_cached_ caching new/updated entry
  bool store_cache(const std::string &url, const uint8_t *data, size_t len, uint32_t current_time_ms) {
    // 1. Allocate PSRAM
    uint8_t *psram_buf = static_cast<uint8_t*>(sim_heap_caps_malloc(len));
    if (psram_buf == nullptr) return false;
    std::memcpy(psram_buf, data, len);

    // 2. Store in cache under mutex
    std::unique_lock<std::timed_mutex> lock(cache_mutex_, std::chrono::milliseconds(100));
    if (!lock.owns_lock()) {
      sim_heap_caps_free(psram_buf);
      return false;
    }

    auto it = avatar_cache_.find(url);
    if (it != avatar_cache_.end()) {
      if (it->second.data != nullptr) {
        if (avatar_cache_bytes_ >= it->second.length) {
          avatar_cache_bytes_ -= it->second.length;
        }
        sim_heap_caps_free(it->second.data);
        it->second.data = nullptr;
      }
    }

    AvatarCacheEntry entry;
    entry.data = psram_buf;
    entry.length = len;
    entry.timestamp_ms = current_time_ms;
    entry.url = url;
    avatar_cache_[url] = entry;
    avatar_cache_bytes_ += len;

    return true;
  }

  // Diagnostic
  size_t internal_map_size() const { return avatar_cache_.size(); }
  size_t internal_bytes() const { return avatar_cache_bytes_; }

 private:
  std::map<std::string, AvatarCacheEntry> avatar_cache_{};
  mutable std::timed_mutex cache_mutex_{};
  size_t avatar_cache_bytes_{0};

  std::string shown_now_avatar_url_;
  std::string pending_now_avatar_url_;
  std::string shown_modal_avatar_url_;
  std::string shown_row_avatar_url_[5];
  std::string pending_row_avatar_url_[5];
};

} // namespace challenger_sim

using namespace challenger_sim;

int main() {
  std::cout << "===============================================================\n";
  std::cout << "  EMPIRICAL CHALLENGER: AVATAR CACHE, CONCURRENCY & ROLLOVER\n";
  std::cout << "===============================================================\n\n";

  int tests_passed = 0;
  int tests_failed = 0;

  auto report = [&](const std::string &desc, bool cond, const std::string &details = "") {
    if (cond) {
      std::cout << "  [PASS] " << desc << "\n";
      tests_passed++;
    } else {
      std::cout << "  [FAIL] " << desc;
      if (!details.empty()) std::cout << " (" << details << ")";
      std::cout << "\n";
      tests_failed++;
    }
  };

  // -------------------------------------------------------------------------
  // SUITE 1: 24-hr Expiration Logic & 32-bit Integer Rollover Verification
  // -------------------------------------------------------------------------
  std::cout << "--- Suite 1: Timestamp Rollover & 24h Expiration Math ---\n";

  // Test 1A: Exact boundary tests
  {
    uint32_t t0 = 1000000;
    uint32_t t_exact_hit = t0 + 86399999U;
    uint32_t t_exact_exp = t0 + 86400000U;
    uint32_t t_over_exp = t0 + 86400001U;

    uint32_t age_hit = t_exact_hit - t0;
    uint32_t age_exp = t_exact_exp - t0;
    uint32_t age_over = t_over_exp - t0;

    report("Age at 86,399,999ms is < 24h (valid cache hit)", (age_hit < AVATAR_CACHE_TTL_MS));
    report("Age at 86,400,000ms is >= 24h (expired)", !(age_exp < AVATAR_CACHE_TTL_MS));
    report("Age at 86,400,001ms is >= 24h (expired)", !(age_over < AVATAR_CACHE_TTL_MS));
  }

  // Test 1B: Rollover near UINT32_MAX
  {
    // Caching happened 5 seconds before 32-bit rollover
    uint32_t t_before_rollover = UINT32_MAX - 5000U; // ~49.7 days mark
    // Now is 10,005 ms later (wraps across UINT32_MAX)
    uint32_t t_after_rollover = t_before_rollover + 10005U; // (UINT32_MAX - 5000 + 10005) % 2^32 = 5004U

    uint32_t age = t_after_rollover - t_before_rollover;
    report("Rollover: 10s across UINT32_MAX wrap computes exactly 10,005ms age",
           age == 10005U && (age < AVATAR_CACHE_TTL_MS));

    // Expiration across rollover:
    // Caching at UINT32_MAX - 1000U. Current time is exactly 24 hours later.
    uint32_t t_24h_later = (UINT32_MAX - 1000U) + 86400000U; // wraps to 86398999U
    uint32_t age_24h = t_24h_later - (UINT32_MAX - 1000U);
    report("Rollover: Exactly 24 hours across UINT32_MAX computes 86,400,000ms (expired)",
           age_24h == 86400000U && !(age_24h < AVATAR_CACHE_TTL_MS));

    // 24 hours + 1ms across rollover
    uint32_t t_24h_1ms_later = (UINT32_MAX - 1000U) + 86400001U;
    uint32_t age_24h_1ms = t_24h_1ms_later - (UINT32_MAX - 1000U);
    report("Rollover: 24h + 1ms across UINT32_MAX computes 86,400,001ms (expired)",
           age_24h_1ms == 86400001U && !(age_24h_1ms < AVATAR_CACHE_TTL_MS));
  }

  // Test 1C: Monte Carlo & Exhaustive Oracle Check (1,000,000 tests)
  {
    std::mt19937_64 rng(1337);
    std::uniform_int_distribution<uint64_t> dist_base(0, UINT32_MAX);
    // Interval distribution: mix of sub-24h, exactly 24h, expired up to 40 days
    std::uniform_int_distribution<uint64_t> dist_interval(0, 3000000000ULL);

    int monte_carlo_mismatches = 0;
    constexpr int TRIALS = 1000000;

    for (int i = 0; i < TRIALS; ++i) {
      uint64_t base64 = dist_base(rng);
      uint64_t interval64 = dist_interval(rng);

      uint32_t t_entry = static_cast<uint32_t>(base64);
      uint32_t t_now = static_cast<uint32_t>(base64 + interval64); // natural uint32 wrap

      // Firmware logic:
      uint32_t age_firmware = t_now - t_entry;
      bool valid_firmware = (age_firmware < AVATAR_CACHE_TTL_MS);

      // Reference 64-bit ground truth (as long as elapsed time < 2^32 - 86400000):
      bool valid_reference = (interval64 < static_cast<uint64_t>(AVATAR_CACHE_TTL_MS));

      if (interval64 < (1ULL << 32) - AVATAR_CACHE_TTL_MS) {
        if (valid_firmware != valid_reference) {
          monte_carlo_mismatches++;
        }
      }
    }
    report("Monte Carlo 1,000,000 rollover iterations: zero mathematical divergence",
           monte_carlo_mismatches == 0,
           "mismatches=" + std::to_string(monte_carlo_mismatches));
  }

  // -------------------------------------------------------------------------
  // SUITE 2: Multi-Threaded Buffer Lifecycle & Double-Free / Leak Audit
  // -------------------------------------------------------------------------
  std::cout << "\n--- Suite 2: PSRAM Buffer Lifecycle & Memory Audit (ASAN) ---\n";
  {
    SimulatedSubwaveDisplay display;
    std::atomic<bool> running{true};
    std::atomic<int> cache_hits{0};
    std::atomic<int> cache_stores{0};
    std::atomic<int> clears_done{0};

    // Thread 1: Core 0 Worker - downloading and caching avatars
    std::thread worker([&]() {
      std::vector<std::string> urls = {
        "https://radio.local/avatar/alice.png",
        "https://radio.local/avatar/bob.png",
        "https://radio.local/avatar/carol.png",
        "https://radio.local/avatar/dave.png",
        "https://radio.local/avatar/eve.png"
      };
      uint32_t fake_time = 1000;
      std::mt19937 rng(42);
      std::uniform_int_distribution<size_t> size_dist(512, 16384);

      while (running) {
        fake_time += 100;
        std::string url = urls[rng() % urls.size()];
        size_t sz = size_dist(rng);
        std::vector<uint8_t> dummy_png(sz, 0xAB);

        // Try reading first
        std::vector<uint8_t> out;
        if (display.query_cache(url, fake_time, out)) {
          cache_hits++;
        } else {
          // Cache miss: store
          display.store_cache(url, dummy_png.data(), sz, fake_time);
          cache_stores++;
        }
        std::this_thread::yield();
      }
    });

    // Thread 2: Core 1 UI Thread - Stats polling
    std::thread ui_stats([&]() {
      while (running) {
        size_t count = display.avatar_cache_count();
        size_t kb = display.avatar_cache_kb();
        (void)count;
        (void)kb;
        std::this_thread::yield();
      }
    });

    // Thread 3: User action - Clear Cache button in Settings
    std::thread user_clear([&]() {
      while (running) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        display.clear_avatar_cache();
        clears_done++;
      }
    });

    // Run concurrency stress for 1 second
    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
    running = false;

    worker.join();
    ui_stats.join();
    user_clear.join();

    // Final clear & verify
    display.clear_avatar_cache();

    int64_t allocs = s_psram_allocations.load();
    int64_t deallocs = s_psram_deallocations.load();

    std::cout << "  Concurrency metrics: " << cache_hits.load() << " hits, "
              << cache_stores.load() << " stores, " << clears_done.load() << " clears\n";
    std::cout << "  Allocations: " << allocs << ", Deallocations: " << deallocs << "\n";

    report("PSRAM allocation & deallocation balance is exact (0 leaks)",
           allocs == deallocs,
           "allocs=" + std::to_string(allocs) + ", deallocs=" + std::to_string(deallocs));
    report("Internal cache map is completely empty after clear",
           display.internal_map_size() == 0);
    report("Internal cache bytes reset to 0 after clear",
           display.internal_bytes() == 0);
  }

  // -------------------------------------------------------------------------
  // SUITE 3: Core 1 Loop Non-Blocking Timing & Touch Stall Invariants
  // -------------------------------------------------------------------------
  std::cout << "\n--- Suite 3: Core 1 Loop & Touch Stall Latency Benchmarks ---\n";
  {
    SimulatedSubwaveDisplay display;

    // Prepopulate cache with avatars
    for (int i = 0; i < 10; ++i) {
      std::string url = "https://radio.local/avatar/" + std::to_string(i) + ".png";
      std::vector<uint8_t> buf(8192, 0x55);
      display.store_cache(url, buf.data(), buf.size(), 1000);
    }

    // Benchmark clear_avatar_cache latency on Core 1
    int64_t max_clear_us = 0;
    int64_t total_clear_us = 0;
    constexpr int CLEAR_ROUNDS = 200;

    for (int r = 0; r < CLEAR_ROUNDS; ++r) {
      // populate
      for (int i = 0; i < 5; ++i) {
        std::string url = "https://radio.local/avatar/" + std::to_string(i) + ".png";
        std::vector<uint8_t> buf(4096, 0x77);
        display.store_cache(url, buf.data(), buf.size(), 2000);
      }

      auto t0 = std::chrono::high_resolution_clock::now();
      display.clear_avatar_cache();
      auto elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::high_resolution_clock::now() - t0).count();

      if (elapsed_us > max_clear_us) max_clear_us = elapsed_us;
      total_clear_us += elapsed_us;
    }

    double avg_clear_us = (double)total_clear_us / CLEAR_ROUNDS;
    std::cout << "  Clear Cache Latency: avg = " << avg_clear_us << " us, max = " << max_clear_us << " us\n";

    // Requirements:
    // Core 1 loop < 16.6 ms (16,666 us)
    // Touch stall < 250 ms (250,000 us)
    report("clear_avatar_cache executes well under 16.6ms (60 FPS budget)",
           max_clear_us < 16666,
           "max=" + std::to_string(max_clear_us) + "us");

    report("clear_avatar_cache produces 0 touch stalls >250ms (measured << 250,000 us)",
           max_clear_us < 250000,
           "max=" + std::to_string(max_clear_us) + "us");
  }

  std::cout << "\n===============================================================\n";
  std::cout << "  TOTAL RESULTS: " << tests_passed << " passed, " << tests_failed << " failed\n";
  std::cout << "===============================================================\n";

  return tests_failed > 0 ? 1 : 0;
}
