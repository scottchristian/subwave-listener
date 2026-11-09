# Project: Presenter Modal Layout, Avatar Sizing & Multi-Host Production Release

## Architecture
- **Hardware Target**: Guition ESP32-P4 JC8012P4A1 (1280x800 landscape MIPI DSI, GSL3680 capacitive touch controller, `/dev/cu.usbserial-214220`).
- **Core Allocation & Concurrency**:
  - Core 0: FreeRTOS `subwave_worker` task handles network requests (shared HTTP) and chunked PNG image decoding into `RuntimeImage`.
  - Core 1: ESPHome main loop / LVGL UI thread renders UI at 60 FPS with zero blocking delays and zero touch stalls >250ms.
  - Synchronization: FreeRTOS mutex (`cache_mutex_`) guards the PSRAM avatar cache map between Core 0 worker task and Core 1 UI loop. Inter-core queues (`worker_cmd_queue_`, `ui_result_queue_`) operate with strict 0-tick timeouts.
- **Backend Service & Schedule Ingestion (`lib/`)**:
  - `lib/device-types.ts`: Introduces `DevicePresenter` `{ id: string; name: string; role: string; tagline?: string | null; avatar?: string | null }`.
  - `DeviceState["byline"]` and `DeviceSlot["show"]` provide `presenters: DevicePresenter[]`.
  - `lib/device-service.ts`: Resolves personas from upstream `/schedule` (mapping `personaId` to host and `guestPersonaIds` to guests with roles, avatars, and taglines).
- **Firmware Data Model & UI Representation (`device/firmware/`)**:
  - `display_client.h`: Extends `Byline` and `ScheduleSlot` with `std::vector<Presenter> presenters`.
  - `display_client.cpp`: Parses JSON presenter arrays and routes avatar requests asynchronously on Core 0.
  - `common/display.yaml`: Enlarges presenter modal card (1040x600) with 280x280 avatar well, `font_title` for name (Newsreader 48), `font_body` for role & tagline (Archivo 26).
  - `subwave_display/ui.cpp`: Implements `LV_IMAGE_ALIGN_COVER` and `lv_image_set_scale` for proper avatar scaling. Implements `"No description provided."` fallback for empty description/tagline. Supports multi-presenter switcher tabs.
  - `common/screens/now.yaml` & `common/screens/shows.yaml`: Support secondary co-host/guest avatar display.
- **PSRAM Avatar Cache & Build Tooling**:
  - 16MB external PSRAM caches up to 20 presenters (~1.2MB–1.5MB footprint) with 24-hour expiration (`AVATAR_CACHE_TTL_MS = 86400000U`).
  - Docker ESPHome 2026.7.0 compilation, esptool 4.12.0 flashing at 115200 baud, and `test_touch.py` diagnostic verification.

## Code Layout
- `lib/device-types.ts`: TypeScript interfaces for `DevicePresenter`, `DeviceState`, `DeviceSlot`.
- `lib/device-service.ts`: Ingestion of schedule personas, `buildByline()`, `buildDeviceSchedule()`.
- `device/firmware/subwave_display/display_client.h`: Data structures (`Presenter`, `Byline`, `ScheduleSlot`, `PresenterModalState`).
- `device/firmware/subwave_display/display_client.cpp`: FreeRTOS Core 0 worker task, cJSON parsing, queue dispatch, cache methods. Line range `[1210, 1300]` strictly preserved.
- `device/firmware/common/display.yaml`: Modal card geometry, avatar well, typography, online image buffer sizing.
- `device/firmware/common/screens/now.yaml`: Now playing screen layout and guest avatar well.
- `device/firmware/common/screens/shows.yaml`: Schedule rows layout and co-host avatar widgets.
- `device/firmware/common/binding.yaml`: 1:1 widget bindings for C++ UI.
- `device/firmware/subwave_display/ui.cpp` & `ui.h`: LVGL UI helpers, avatar scaling, fallback text, presenter switcher.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | DevicePresenter Interface | Define `DevicePresenter` `{ id, name, role, tagline, avatar }` in `lib/device-types.ts` | M1 | Survey Explorer 2 / R2 |
| 2 | Backend Byline Presenters Population | Populate `byline.presenters` in `lib/device-service.ts` from activeShow persona and guests | M1 | Survey Explorer 2 / R2 |
| 3 | Backend Schedule Guest Persona Resolution | Populate guest avatars and taglines in `slot.show.presenters` and `slot.show.guests` from schedule feed | M1 | Survey Explorer 2 / R2 |
| 4 | Firmware Presenter Structs & Vectors | Define `Presenter` struct and add `std::vector<Presenter> presenters` to `Byline` & `ScheduleSlot` in `display_client.h` | M2 | Survey Explorer 2 / R2 |
| 5 | Firmware cJSON Presenter Parsing | Parse `presenters` array in `parse_state_` and `parse_schedule_` in `display_client.cpp` | M2 | Survey Explorer 2 / R2 |
| 6 | Enlarged Modal Card Layout | Enlarge `presenter_card` to 1040x600 with 280x280 avatar well in `display.yaml` | M2 | Survey Explorer 1 / R1 |
| 7 | Presenter Avatar Scaling & Alignment | Apply `LV_IMAGE_ALIGN_COVER` and `lv_image_set_scale` in `ui.cpp` to eliminate miniature avatar rendering | M2 | Survey Explorer 1 / R1 |
| 8 | Modal Typography Enhancement | Use `font_title` (Newsreader 48) for presenter name and `font_body` (Archivo 26) for role and tagline | M2 | Survey Explorer 1 / R1 |
| 9 | Missing Description Fallback Text | Render `"No description provided."` in `ui.cpp` when description or tagline is empty/null | M2 | Survey Explorer 1 / R1 |
| 10 | Now Playing & Schedule Multi-Avatar | Display small avatars for co-hosts/guests in Now Playing and Schedule rows | M2 | Survey Explorer 2 / R2 |
| 11 | Multi-Presenter Modal Switcher | Support viewing and switching multiple presenters within the modal popup | M2 | Survey Explorer 2 / R2 |
| 12 | PSRAM Caching for Multi-Presenter Avatars | Cache all presenter avatars in PSRAM with 24-hr TTL check (`AVATAR_CACHE_TTL_MS`) | M2 | Survey Explorer 3 / R3 |
| 13 | Concurrency & Line Number Preservation | Preserve `[1210, 1300]` line range for `vTaskDelay(1)` and `slot_index = -3` literal routing | M2 | Survey Explorer 3 / R3 |
| 14 | Automated Test Battery Execution | Run `npm run check:unit`, `check:firmware-bindings`, `check:screen-layout`, `check:firmware-async`, `check:device-capabilities`, `check-firmware-concurrency` | M3 | Survey Explorer 3 / R4 |
| 15 | Docker ESPHome Compilation | Compile firmware via Docker ESPHome 2026.7.0 producing fresh `firmware.factory.bin` | M3 | Survey Explorer 3 / R4 |
| 16 | Esptool Hardware Flashing | Flash firmware to `/dev/cu.usbserial-214220` at 115200 baud via esptool | M3 | Survey Explorer 3 / R4 |
| 17 | Live Hardware Diagnostic Verification | Execute `test_touch.py` to confirm 60 FPS loop and 0 touch stalls >250ms | M3 | Survey Explorer 3 / R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Backend Multi-Host Data Model & Schedule Ingestion | `lib/device-types.ts`, `lib/device-service.ts`: `DevicePresenter`, `buildByline()` presenters array, `buildDeviceSchedule()` guest avatar/tagline enrichment | none | IN_PROGRESS |
| 2 | M2: Firmware Multi-Host Models, Modal Layout & Scaling | `display_client.h`, `display_client.cpp`, `common/display.yaml`, `now.yaml`, `shows.yaml`, `binding.yaml`, `ui.cpp`, `ui.h`: 1040x600 modal, 280x280 avatar, LVGL cover scaling, typography, fallback text, multi-host parsing, co-host avatars, presenter switcher, PSRAM cache | M1 | PLANNED |
| 3 | M3: Build Verification, Docker Compilation & Flashing | Automated check suites, Docker ESPHome compilation to fresh `firmware.factory.bin`, esptool flashing at 115200 baud, live `test_touch.py` diagnostic verification | M1, M2 | PLANNED |

## Interface Contracts
### Backend ↔ Firmware JSON Contract
- `byline.presenters`: Array of `{ id: string, name: string, role: string, tagline?: string, avatar?: string }`. Primary host has `role: "Host"`, guests have `role: "Guest"` (or `"Co-Host"`).
- `slot.show.presenters`: Array of `{ id: string, name: string, role: string, tagline?: string, avatar?: string }`.
- `slot.show.guests`: Array enriched with `avatar: string` and `tagline: string`.
- Backward compatibility: `byline.presenter`, `byline.avatar`, `byline.tagline`, `slot.show.host`, `slot.show.avatar`, `slot.show.tagline` remain populated for existing clients.
### `display_client` ↔ `ui.cpp` Contract
- `void presenter_modal_show(const char *name, const char *role, const char *tagline, esphome::image::Image *placeholder_img)`: Displays modal with scaled avatar and fallback text `"No description provided."`.
- `void presenter_modal_set_presenter(const Presenter &presenter, esphome::image::Image *placeholder_img)`: Updates modal fields when switching between presenters.
- `void ui_apply_modal_avatar(esphome::image::Image *img)`: Applies decoded avatar image DSC with `LV_IMAGE_ALIGN_COVER` and scale calculation.
