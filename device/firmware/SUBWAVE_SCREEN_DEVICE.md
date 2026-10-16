# SUB/WAVE Screen — device firmware doc

This file is the working knowledge base for the Guition ESP32-P4 JC8012P4A1 wall
screen running SUB/WAVE. It is NOT committed to git. It exists so future agents
don't repeat the investigation that produced it.

## What this device is

- Thin client / wall display for SUB/WAVE station. No likes, requests, Spotify
  links, admin access, or Home Assistant dependency. Never signed in; never
  appears in signedIn or listening counts.
- Hardware: Guition ESP32-P4 JC8012P4A1 (P4 rev v1.3, 40 MHz crystal, 16 MB
  flash). WiFi/BT is a SEPARATE ESP32-C6 on SDIO — if WiFi dies after a clean
  flash, check the coprocessor before suspecting the P4.
- Chip revision v1.3. MAC e8:f6:0a:e6:f3:7f.
- Firmware: ESPHome 2026.7.0, esp-idf v5.5.4 toolchain, Docker container
  `esphome/esphome:2026.7.0`.
- Provisioning: flash the compiled binary over native USB1. The binary carries
  `device_id` and `claim_token` compiled in — there is no second credential
  part and no `*_factory` build variant. Admin-only provisioning; confers
  nothing afterwards.

## Entry point and project files

| File | Purpose |
|---|---|
| `device/firmware/builds/subwave-jc8012p4a1.yaml` | Build entry point. `project: causewayfm.subwave-screen`. Carries `device_id`, `claim_token`, `firmware_version`. |
| `device/firmware/builds/network_adapter_esp32c6.bin` | C6 coprocessor firmware (sha256 pinned). 1.1 MB binary, committed next to the build file. |
| `device/firmware/common/display.yaml` | Panel + LVGL. `display: !include ${panel_include}` — the panel block is swappable via substitution. |
| `device/firmware/common/panel.yaml` | Stock ESPHome panel (old revision). |
| `device/firmware/common/panel_vendor.yaml` | Old revision panel as `model: CUSTOM` + full vendor 198-command sequence. |
| `device/firmware/common/panel_vendor_new.yaml` | **ACTIVE.** New revision panel as `model: CUSTOM` + 204-command sequence, 70 MHz pixel clock, vsync back 10 / front 30. |
| `device/firmware/common/jc8012p4a1_init.yaml` | Old revision vendor init sequence, 198 commands. Ground truth diffed against ESPHome's model. |
| `device/firmware/common/jc8012p4a1_init_new.yaml` | New revision vendor init sequence, 204 commands. |
| `device/firmware/tools/gen_jc8012p4a1_init.py` | Generator: parses both vendor sequences out of `jc8012p4a1.cc`, cross-checks against ESPHome's model list, emits YAML. |
| `device/firmware/common/web_setup.yaml` | DELETED. Was the failed inline handler approach (fabricated API names, never worked). Do not recreate. |
| `device/firmware/subwave_setup_web/` | Custom web wizard component (`__init__.py`, `setup_web.h`, `setup_web.cpp`). Serves the setup page, captive-detection probes, `/scan`, `/save`. |
| `device/firmware/common/binding.yaml` | LVGL widget bindings, runs after LVGL tree exists (1s delay). |
| `device/firmware/common/screens/*.yaml` | Window bodies (now/shows/settings/setup), bare widget lists. |
| `device/firmware/subwave_display/` | HTTP client / LVGL UI bindings. |

## THE ROOT CAUSE — do not forget this

This unit's label reads `JC8012P4A1C_I_W_Y`. The vendor demo tree names it
`JC8012P4A1C_I_W_Y_New_Panel`. The vendor ships **two genuinely different
panels under nearly the same name**, and they are different drivers, not
tunings of one:

| | Old revision | New revision (this unit) |
|---|---|---|
| Commands | 198 | 204 |
| Pixel clock | 60 MHz | 70 MHz |
| vsync back porch | 8 | 10 |
| vsync front porch | 20 | 30 |

The two command lists diverge at index 7 (`0x01`: old `0x39`, new `0x44`) and **never
resync** — 185 of 198 positions differ (93%). ESPHome's `model: JC8012P4A1`
encodes the old revision.

Every command ESPHome sends is still ACKed cleanly — DBI acknowledgements are
generic to the link, not a claim the register was understood. So the symptom is
a panel that lights up, logs are perfectly clean, LVGL binds all objects, and
nothing reaches the glass. It looks exactly like a widget-layout problem. It
wasn't.

**1.1.0 is running `panel_vendor_new.yaml`:** `model: CUSTOM`, the new
revision's 204-command sequence at 70 MHz, vsync back 10 / front 30. The panel
now renders the setup screen, QR code, and URL at `http://192.168.4.1`.

Never change `panel_include` or the vendor sequence files without regenerating
and re-running `scripts/check-panel-init.mts`. The two files must stay in
sync: `panel_vendor.yaml` includes `jc8012p4a1_init.yaml` (198 commands, 2
delays, includes command `0x4A`); `panel_vendor_new.yaml` includes
`jc8012p4a1_init_new.yaml` (204 commands, 2 delays).

## Flashing

Native USB1 port: `/dev/cu.usbmodem1101`. Baud 921600. The port **vanishes
mid-session** and needs a physical unplug/replug. The CH340 bridge
`/dev/cu.usbserial-214220` wedges on write — do not use it for flashing.

```
python3 -m esptool --chip esp32p4 -p /dev/cu.usbmodem1101 --baud 921600 \
  --before default_reset --after hard_reset write_flash -z \
  --flash_mode dio --flash_freq 40m --flash_size 16MB \
  0x0 /Users/scott/GitHub/subwave-listener/device/firmware/builds/.esphome/build/subwave-screen/build/firmware.factory.bin
```

The trailing `hard_reset` frequently throws `OSError: Device not configured`
after the hash check — **the write already succeeded**. `Hash of data verified.`
is the real signal.

Build (never touch the binary by hand):
```
cd device/firmware && docker run --rm --privileged -v /dev:/dev -v $(pwd):/config -w /config esphome/esphome:2026.7.0 compile builds/subwave-jc8012p4a1.yaml
```

Always bump `firmware_version` in `builds/subwave-jc8012p4a1.yaml` before
flashing, so the boot log proves a new image landed:
`[app:153]: Project causewayfm.subwave-screen version X.Y.Z`

Log capture (non-TTY environment):
```
python3 -c "
import serial, time
ser = serial.Serial('/dev/cu.usbserial-214220', 115200, timeout=1)
time.sleep(1)
ser.setDTR(True); ser.setRTS(True); time.sleep(0.15)
ser.setDTR(False); ser.setRTS(False); time.sleep(4)
# read pyserial loop ...
"
```

## Panel timing specifics (the other half of the root cause)

The vendor's `esp_lcd_jd9365.c` does:
```c
jd9365->init = panel_handle->init;   // line 123 — saves generic DPI panel init
```
…then calls it again at line 493. So the vendor driver **is** the generic
`esp_lcd_new_panel_dpi()` panel plus a command list plus `disp_on_off` /
`invert_color` wrappers. ESPHome already does everything that driver does.
Porting jd9365 was considered and rejected — `panel_vendor_new.yaml` is
functionally the same thing expressed in ESPHome, and the panel now works.

ESPHome's `mipi_dsi` **appends** `init_sequence` to the model's built-in
sequence; it does not replace it. Supplying the vendor's full list under
`model: JC8012P4A1` sends 391 commands, stalls ~9s on an ACK timeout, and
boot-loops against the 5s task watchdog. That was 1.0.7. `model: CUSTOM` is
the only correct way to supply a whole sequence.

`init_sequence` delays require an explicit unit: `- delay 120` fails
validation; `- delay 120ms` works. `map_sequence` rejects bare numbers.

## Web setup wizard

ESPHome's captive portal was removed entirely:
```cpp
CaptivePortal::canHandle() = return active_ && method == HTTP_GET;
```
It claims every GET on the device and cannot yield `/`. The custom component
`subwave_setup_web` takes `/`, `/scan`, `/save` and the captive-detection
probes (`/generate_204`, `/hotspot-detect.html`, etc.). Everything else
(`/update`, `/api`, dashboard) stays with `web_server`.

The wizard page is self-contained — no CDN, no webfonts. It polls `/scan` every
8s and shows the AP list, plus the browser's timezone. `/save` takes ssid/psk
and defers `save_wifi_sta` via `App.scheduler.set_timeout` (NVS write must not
run on the HTTP task).

WiFi scan results are retained because removing `captive_portal` removed the
only thing calling `needs_full_scan_results_()`. The fix:
```cpp
wifi->set_keep_scan_results(true);
```
placed in `subwave_setup_web`'s `setup()` at priority 260 (`WIFI + 10`), which
wins over `web_server`'s 249 under ESPHome's descending-priority sort. This runs
before wifi's own setup at 250, so the boot scan retains everything.

Do **not** call `start_scanning()` from the wizard — it assigns
`WIFI_COMPONENT_STATE_STA_SCANNING` and disturbs the access point.

## LVGL / display

Panel is natively 800x1280 portrait, driven as 1280x800 landscape via software
rotation (PPA accelerated). LVGL page widgets go directly in the page's
`widgets:` list with absolute `x`/`y` positioning — not nested in `main_page_root`
containers. Main page bg `0x000000`. Backlight on GPIO23 via LEDC PWM (separate
from panel power). ESP LDO channel 3 @ 2500 mV powers the DSI PHY — without it
the panel is black with clean logs.

Touch: GSL3680 on I2C (GPIO7 SDA, GPIO8 SCL), mirror_x true, mirror_y false,
reset GPIO22, interrupt GPIO21.

Backlight: `restore_mode: ALWAYS_OFF`, default transition 800ms. `CONFIG_LV_DISP_DEF_REFR_PERIOD=10` for smooth 650ms crossfades.

Window switching: `window_go` slides 1280px at 8px steps with `lv_obj_invalidate`.
Skip is 1:1 with the web app including solo-mode behaviour.

## Gate checks

All pass (read-only, no compiler, no hardware):
- `check:panel-init` — 21/21 (new). Verified to fail on the real fault shapes:
  appending to a model's sequence, bare-number delays, truncated sequence, wrong
  sequence file vs panel variant.
- `check:device-firmware` — 29/29
- `check:firmware-bindings` — 7/7
- `check:device-hosts` — 153/153 (was crashing on a dangling symlink
  `device/firmware/.esphome/idf/penvs/5.5.4/bin/python`; fixed `walkTs` to use
  `statSync(..., {throwIfNoEntry: false})` and skip `.esphome`)
- `check:device-capabilities` — 125/125
- `check:device-isolation` — 170/170
- `check:device-routes`, `check:device-skip`, `check:device-cutover`, etc. — pass
- `tsc --noEmit` — clean

`check:panel-init` is wired into `check:unit` via package.json.

## If this unit dies and another Guition arrives

It might be the OLD revision. If a fresh flash shows a blank panel with clean
logs on identical config, try `panel_vendor.yaml` (198 commands, 60 MHz,
vsync 8/20) before suspecting hardware. The check suite enforces the two files
stay distinct; do not merge them.

## What is NOT done

- Timezone and coordinates are asked at setup and logged, but not yet persisted.
  `StationSettings` in `display_client.h` has brightness/orientation/theme_mode/
  idle_mode/skip_enabled — add latitude/longitude/timezone there, persist via
  `global_preferences` (fixed-size buffer, see `save_token_()`), and push to the
  server. The server's device-types contract would need matching fields.
- `panel_vendor.yaml` (old revision) exists but is not the default; it has not
  been verified on hardware.
- The light bleed around the top/right edges is physical backlight bleed on
  this panel class — content is sharp, so it's not a timing artifact. Not
  fixable in firmware.

## Ports and tooling

- Flash: `/dev/cu.usbmodem1101` (native USB1, 921600). Vanishes mid-session;
  unplug/replug physically.
- Log: `/dev/cu.usbserial-214220` (CH340, 115200). Wedges on write — never flash
  over it.
- AP SSID: `SUBWAVE-SCREEN`, open, IP 192.168.4.1 while unclaimed.
- Docker: `esphome/esphome:2026.7.0`, never `latest`.
- The vendor source tree lives in `~/Downloads/JC8012P4A1C_I_W_Y/` — not in
  this repo. `gen_jc8012p4a1_init.py` takes it as an argument; do not bake that
  path into anything.
