# SUB/WAVE Screen — device firmware doc

This file is the working knowledge base for the Guition ESP32-P4 JC8012P4A1 wall
screen running SUB/WAVE. It is committed so future agents don't repeat the
investigation that produced it.

Two things in here are load-bearing and were expensive to find: **the panel
revision mismatch** below, and **the WiFi scan fault** further down. Both
present as a clean boot and an empty screen.

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
- Provisioning: ONE standard image for every screen. Flash it, then on the
  device's setup screen enter the server URL and the bind code shown in the
  admin panel (or use the web wizard at the device's IP). The device tests
  the connection, fetches its identity from the station's bind endpoint, and
  stores it in flash. No per-device build step.

## Entry point and project files

| File | Purpose |
|---|---|
| `device/firmware/builds/subwave-jc8012p4a1.yaml` | Build entry point. `project: causewayfm.subwave-screen`. `device_id`, `claim_token` and `server_url` are all **optional** (empty by default) — the standard image carries no identity. The device collects them during setup via `bind_code`. `firmware_version` is baked in. |
| `device/firmware/builds/network_adapter_esp32c6.bin` | C6 coprocessor firmware (sha256 pinned). 1.1 MB binary, committed next to the build file. |
| `device/firmware/common/display.yaml` | Panel + LVGL. `display: !include ${panel_include}` — the panel block is swappable via substitution. |
| `device/firmware/common/panel.yaml` | Stock ESPHome panel (old revision). |
| `device/firmware/common/panel_vendor.yaml` | Old revision panel as `model: CUSTOM` + full vendor 198-command sequence. |
| `device/firmware/common/panel_vendor_new.yaml` | **ACTIVE.** New revision panel as `model: CUSTOM` + 204-command sequence, 70 MHz pixel clock, vsync back 10 / front 30. |
| `device/firmware/common/jc8012p4a1_init.yaml` | Old revision vendor init sequence, 198 commands. Ground truth diffed against ESPHome's model. |
| `device/firmware/common/jc8012p4a1_init_new.yaml` | New revision vendor init sequence, 204 commands. |
| `device/firmware/tools/gen_jc8012p4a1_init.py` | Generator: parses both vendor sequences out of `jc8012p4a1.cc`, cross-checks against ESPHome's model list, emits YAML. |
| `device/firmware/common/web_setup.yaml` | DELETED. Was the failed inline handler approach (fabricated API names, never worked). Do not recreate. |
| `device/firmware/subwave_setup_web/` | Custom web wizard component (`__init__.py`, `setup_web.h`, `setup_web.cpp`). Serves the setup page, captive-detection probes, `/scan`, `/save`. Also owns the WiFi scan: `request_scan()`, `log_radio_state()`, and the `WiFiScanResultsListener` that fills the on-screen list. |
| `device/firmware/tools/capture_log.py` | Boot-log capture over the CH340. Handles the auto-download DTR/RTS latch, which is the thing you will otherwise get wrong. |
| `device/firmware/tools/gen_setup_password.py` | Generates the per-device AP password into `common/ap_password.{yaml,txt}`. |
| `device/firmware/common/screens/scripts.yaml` | Screen scripts and globals, including the WiFi scan/populate/connect path and the keyboard toggle. |
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
now renders the setup screen and QR code.

Never change `panel_include` or the vendor sequence files without regenerating
and re-running `scripts/check-panel-init.mts`. The two files must stay in
sync: `panel_vendor.yaml` includes `jc8012p4a1_init.yaml` (198 commands, 2
delays, includes command `0x4A`); `panel_vendor_new.yaml` includes
`jc8012p4a1_init_new.yaml` (204 commands, 2 delays).

## THE DEVICE HAD NO IDENTITY (1.8.0) — the worst bug in this firmware

Four setters in `subwave_display/__init__.py` were called **without `cg.add()`**:

```python
var.set_server_url(config[CONF_SERVER_URL])   # expression, discarded
var.set_device_id(config[CONF_DEVICE_ID])
var.set_claim_token(config[CONF_CLAIM_TOKEN])
var.set_setup_ap_ssid(config[CONF_SETUP_AP_SSID])
```

ESPHome codegen is expression-based. A setter call builds a C++ expression and
returns it; **nothing is written into main.cpp until it is passed to `cg.add()`**.
So those four calls emitted no code at all, and the build still succeeded —
generating no code is not an error.

The screen therefore booted with an empty station URL, no device id, no claim
token and no AP SSID. It could never have reached the station or claimed itself.

**Why it survived so long, which is the part worth keeping:** everything that was
ever tested depends on none of those four. The panel rendered. The WiFi scan
worked. The wizard answered on the access point. Every visible behaviour was
correct and the entire identity was missing.

### The companion bug, in YAML rather than Python

`server_url: ${server_url}` was **unquoted**. ESPHome substitutes text before it
parses YAML, so `https://causewayfm.com` had its `//` read as the start of a
comment and the value silently became `https:`. Nothing warned — `https:` is
still a valid URL as far as `cv.url` is concerned.

Same silent failure from the opposite direction: no code emitted, versus a value
mangled before codegen runs. Both are checked now.

Every `${...}` substitution whose value is a string is quoted. Numeric ones are
exempt and must stay bare, or `cv.int_range` rejects the string.

### `check:firmware-setters`

Fails on an unwrapped setter in any external component, and on an unquoted
substitution. Verified to fail on both original faults.

It tracks paren depth, because a line-only scan reports

```python
cg.add(
    var.set_on_scan_script(   # <-- "unwrapped", wrongly
```

as a bug — and a false positive on a check this serious gets ignored. It also
carries sentinels asserting its regexes still match something, because a check
that quietly stops matching reports success forever.

## The connectivity ladder (1.8.0)

`device/provisioning.md` specified it; nothing implemented it. There was no gate
at all, so setup was demanded regardless of whether the WiFi worked.

Four steps, each because it fails differently:

| Step | Test | Fails when |
|---|---|---|
| `NO_WIFI` | `wifi.connected` | no association, or wrong password |
| `NO_ROUTE` | TCP to a **literal** public resolver address | guest network with no route out |
| `NO_DNS` | resolve the station's host | captive portal intercepting DNS |
| `NO_SERVER` | TCP to the station's host:port | misconfigured station address |

**The route step uses a literal address, not a name.** Resolving first would make
it depend on DNS — the step after it — so a device with broken DNS would report
"no route out" and send somebody to sign in to a guest portal that was never the
problem. The canary is a public DNS resolver rather than an HTTP port so the test
depends on nothing the station happens to run; the specific address is in
`route_exists()` and is not a deployment detail worth recording here.

**The station step is PROBED, not read from `server_reachable_`.** That flag is
set by the API client's responses, so on an unprovisioned screen no request has
completed and it is still `false` — the first version read it and reported a
working station as unreachable, on a device that had not even claimed yet. A TCP
connect needs no token and no prior state.

Runs **once**, 18 s after boot. Re-running means a cafe router that stops routing
at 4pm turns a wall screen into a Wi-Fi prompt with no warning, for a problem the
person standing there cannot fix. `NO_SERVER` never demands setup at all — the
password was never wrong, and a wall screen cannot edit a server address.

The quiet line on the now-playing window carries the message. `last_error_` was
written in eight places and read by nobody, so a refused claim, a removed screen
and a skip somebody else got first were all explained into an empty buffer; it is
rendered now.

Verified on hardware: `Connectivity: all four steps pass. Not asking for setup.`

## Flashing

**FLASH ON THE NATIVE USB PORT, READ LOGS ON THE CH340.** The two ports are not
interchangeable and using either for the wrong job wastes a cycle:

| Port | Job | Why |
|---|---|---|
| `/dev/cu.usbmodem*` (native USB1) | **flash only** | Fast (2.7 MB in ~43 s) and reliable, but the device RE-ENUMERATES on every reset, so macOS hands it a new number. It is usually gone by the time you go to read the log. |
| `/dev/cu.usbserial-*` (CH340) | **log capture only** | Stable port. But it WEDGES on write — reliably around 67% of the image — and never recovers without a physical replug. |

If the native port is missing, pulse the CH340's DTR/RTS to reset the chip and
wait ~5s for the native port to reappear:
```python
import serial, time
s = serial.Serial('/dev/cu.usbserial-214220', 115200, timeout=0.3)
s.dtr = False; s.rts = True; time.sleep(0.2); s.dtr = True; s.rts = False
time.sleep(3); s.close()
```

Flash (460800 works reliably; 921600 has also succeeded but is no faster):
```
python3 -m esptool --chip esp32p4 -p /dev/cu.usbmodem1101 --baud 460800 \
  --before default_reset --after hard_reset write_flash -z \
  --flash_mode dio --flash_freq 40m --flash_size 16MB \
  0x0 builds/.esphome/build/subwave-screen/build/firmware.factory.bin
```

**`Hash of data verified.` is the only success signal.** After it you may get
`termios.error: (6, 'Device not configured')` or `OSError: Device not
configured` from the trailing `hard_reset` — that is the port disappearing under
the tool as the chip resets. The write already succeeded.

Build (never touch the binary by hand):
```
cd device/firmware && docker run --rm --privileged -v /dev:/dev -v $(pwd):/config -w /config esphome/esphome:2026.7.0 compile builds/subwave-jc8012p4a1.yaml
```

Always bump `firmware_version` in `builds/subwave-jc8012p4a1.yaml` before
flashing, so the boot log proves a new image landed:
`[app:153]: Project causewayfm.subwave-screen version X.Y.Z`

### Log capture

Use the script — the DTR/RTS lines are the auto-download circuit, not a reset,
and getting them backwards produces four lines of ROM output and silence:

```
python3 device/firmware/tools/capture_log.py 45
```

Asserting DTR and RTS puts the chip in ROM download mode (`waiting for
download`); deasserting both releases the strap and lets the app run.

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

The QR code on the setup screen encodes WiFi connection info
(`WIFI:T:WPA;S:SUBWAVE-SCREEN;P:<password>;;`). A phone scanning it joins the
access point directly using WPA2; the captive portal serves the setup wizard
automatically, like a public Wi-Fi login portal.

The AP uses a WPA2 password, auto-generated per device at build time
(`device/firmware/tools/gen_setup_password.py`). The password is displayed on
the screen and in the QR code so a phone can join without typing manually.

## On-screen setup — two stages

Setup is **two screens**, navigated with `window_go` targets 3 and 4:

### Stage 1 — Connect to Wi-Fi (`setup_wifi_screen`, window target 3)

Shown on boot when the screen has no WiFi association yet. It has:

- **QR code** — encodes WiFi connection info (SSID + password), scannable by phone
- **Network** — shows the AP SSID (SUBWAVE-SCREEN)
- **Password** — shows the AP WPA2 password
- **"Scan"** — starts an ESP32-C6 WiFi scan, populates the network picker
- **Network picker** — shows scan results, deduped by SSID, strongest first
- **Password field** — tap to enter via on-screen keyboard
- **"Connect"** — calls `save_wifi_sta()` then `retry_connect()`. No reboot.
- **"Next →"** — advances to the bind screen (target 4) once WiFi is connected
- **Status label** — shows connection progress messages

WiFi scan results are retained because removing `captive_portal` removed the
only thing calling `needs_full_scan_results_()`. The fix:
```cpp
wifi->set_keep_scan_results(true);
```
placed in `subwave_setup_web`'s `setup()` at priority 260 (`WIFI + 10`), which
wins over `web_server`'s 249 under ESPHome's descending-priority sort. This runs
before wifi's own setup at 250, so the boot scan retains everything.

### Stage 2 — Bind to station (`setup_bind_screen`, window target 4)

Shown on boot when WiFi is already connected but the screen has no identity.
Shown after Stage 1 completes. It has:

- **Server address** — the app's public URL (e.g. `https://causewayfm.com`).
  `https://` is added automatically if omitted.
- **Bind code** — the 7-character code shown on the admin panel when the screen
  was created (e.g. `AB1-C23`). Single-use, 7-day TTL.
- **"Test"** — normalises the server URL and runs `check_connectivity()`.
- **"Bind"** — POSTs the bind code to `/api/devices/bind`, receives
  `deviceId` + `claimToken`, stores them in flash via `save_identity_()`,
  reboots.
- **Status label** — test result / bind result messages

**Boot window selection** (`boot_windows` script):

| Condition | Window shown |
|---|---|
| Identity present | `window_0` (now-playing) |
| No identity, WiFi up | `setup_bind_screen` |
| No identity, no WiFi | `setup_wifi_screen` |

WiFi scan results are retained because removing `captive_portal` removed the
only thing calling `needs_full_scan_results_()`. The fix:
```cpp
wifi->set_keep_scan_results(true);
```
placed in `subwave_setup_web`'s `setup()` at priority 260 (`WIFI + 10`), which
wins over `web_server`'s 249 under ESPHome's descending-priority sort. This runs
before wifi's own setup at 250, so the boot scan retains everything.

## THE SECOND ROOT CAUSE — the network list was always empty

Same shape as the panel fault: clean boot, working wizard, nothing on the glass.
The picker said "Scanning…" forever and never listed a single network.

### Two faults, and both had to be fixed

**(a) The C6 coprocessor's STATION interface was never brought up.**

This device has no `sta:` network configured — it is an access point until
somebody provisions it. So `WiFiComponent::has_sta()` is false, and ESPHome's
entire WiFi state machine is gated behind `if (this->has_sta())`. Nothing ever
puts the coprocessor into APSTA with a live station interface. A coprocessor in
that state answers a scan request with a bare **`ESP_FAIL`** — and `ESP_FAIL` is
exactly what `rpc_rsp_callback()` returns for any slave failure it cannot map to
a named `esp_err`, so the one error that mattered carried no information at all.

**(b) The radio was left mid-scan, permanently.**

ESPHome runs a scan of its own during `wifi:` setup. On this device it never
completes, so the radio stays in the scanning state. While that is true:

- `esp_wifi_scan_start()` returns **`ESP_ERR_WIFI_STATE`** ("WiFi internal state
  error"), and
- **`esp_wifi_scan_stop()` ALSO returns `ESP_ERR_WIFI_STATE`.**

That second one is what made this nearly impossible to read. Stopping the stuck
scan is the fix, and the one call that performs the fix reports the same error
as the call that fails. ESPHome logs both at `ESP_LOGV`, which is below the
device's DEBUG level, so neither ever appeared in the log at all.

### The fix, in three timed steps

`SetupWebComponent::request_scan()` + `loop()`. The steps are separated by 2 s
scheduler timers, and **the separation is load-bearing** — doing them together
fails:

1. `wifi->start_scanning()` — its first act is `wifi_mode_(true, {})`, which is
   what brings the station interface up. Fixes (a). It unavoidably also starts a
   scan, which begins (b).
2. `esp_wifi_scan_stop()` — clears the stuck scan. Fixes (b).
3. `esp_wifi_scan_start()` directly — a clean scan.

Step 3 is done by hand rather than left to `start_scanning()` because
`start_scanning()` stops nothing, so it inherits whatever state the radio is in.
Driving the radio directly also makes it idempotent: tapping **Scan** twice
replaces the running scan instead of being refused.

Measured on the device: `ap_num` 0 → 12 → 16, sixteen networks, collapsed to
seven unique SSIDs.

### Two things that cost time and will cost it again

- **A blocking `delay()` inside a component method reboots the device.** The
  5 s task watchdog wins. Any multi-step radio sequence must be a state machine
  spread across `loop()`, never a sequence with a `delay()` in the middle.
- **A retry bound needs its timer cancelled on the give-up path.** The last
  retry arms a timer; if the give-up branch does not cancel it, the timer
  re-arms the work and the whole sequence restarts from zero forever. The log
  fills with the same failure and it never stops.

### Do not read the empty list as "no networks here"

The three states — scan never started, scan started and heard nothing, scan heard
plenty and the result was lost on the way in — are indistinguishable from the
dropdown. `SetupWebComponent::log_radio_state()` asks the RADIO
(`esp_wifi_scan_get_ap_num`) rather than ESPHome, and logs the difference. It
goes quiet once a scan lands.

## `id()` returns different types depending on the widget

This is the single most confusing thing about writing ESPHome LVGL lambdas in
2026.7, and it produced a long compile-failure loop that was never a real bug in
the widget code.

ESPHome wraps a widget in a typed C++ class **only for the handful of widget
kinds that expose a typed API**. In this build that is exactly two widgets:
`main_page` (`LvPageType`) and `wifi_network_dropdown` (`LvDropdownType`). The
other 141 — every `label`, every `obj`, the `textarea` — are emitted as a bare
`lv_obj_t *`, and `lv_obj_t` is only ever **forward-declared** before a lambda,
so it is an incomplete type there.

Consequences, both of which are hard errors:

| Write | Result |
|---|---|
| `id(wifi_status).set_text("x")` | **fails** — calling a member on a pointer to an incomplete type needs the complete type |
| `id(window_0)->obj` | **fails** — there is no `.obj` member; `id(window_0)` *is* the pointer |

What works:

- Raw widgets → the LVGL **C API**, which takes `lv_obj_t *` by value and never
  dereferences it at the call site: `lv_label_set_text(id(wifi_status), "x")`,
  `lv_textarea_get_text(id(wifi_password))`, `lv_obj_set_x(wins[i], 0)`.
- The dropdown → its real class: `id(wifi_network_dropdown)->set_options(v)` and
  `->get_selected_text()`.
- **An array of pointers to an incomplete type is legal.** `lv_obj_t *wins[4] =
  {...}` compiles; only dereferencing it would not.

Read the generated source to settle any of this. It is on disk and it is
unambiguous:
`builds/.esphome/build/subwave-screen/src/main.cpp`.

### `lv_obj_t` is not the same as `lv_obj_t *`

Declaring a pointer to an incomplete type is fine. Passing one to a function is
fine. So `lv_obj_t *wins[4]` and `lv_obj_set_x(wins[i], n)` both compile, while
`id(x).method()` does not.

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

Window switching: `window_go` slides the two adjacent slots across `window_stack`
at 24px steps, ~570ms total, with a 2 s gap in the API. Skip is 1:1 with the web
app including solo-mode behaviour.

There are five window slots in `window_stack`: window_0 (now-playing),
window_1 (shows), window_2 (settings), setup_wifi_screen (WiFi setup),
setup_bind_screen (bind to station). The rail has four segments matching.
`window_draw_rail` script highlights the active segment.

### `dropdown` and `textarea` do NOT crash LVGL — an earlier note here was wrong

This file previously claimed those widgets "crash on this ESPHome version". That
was a **suspicion recorded as a finding**, from one Guru Meditation observed with
those widgets present and never isolated. It was wrong: both are in the build and
working. `wifi_network_dropdown` is filled with eight real SSIDs and the setup
screen's `wifi_password` textarea reads back correctly.

What actually caused the crash is not established. Do not re-add the claim, and do
not avoid these widgets on the strength of it.

The setup screens use: `qrcode` (WiFi connection string), `label` (text),
`button`, `dropdown` (network picker), `textarea` (password), `keyboard`.

### The on-screen keyboard, and why it covers the network list

Tapping a field opens an LVGL `keyboard`; tapping it again, or Done, closes it.
`lv_keyboard_set_textarea()` is wired by ESPHome from the widget's
`textarea:` key — no LVGL group needed. `keyboard_target` (a global) selects
which field receives input: `0` = WiFi password, `2` = server address,
`3` = bind code.

The keyboard rises over the bottom of the screen and covers the network picker
while it is up. That is deliberate. The panel is 800px tall and already full,
and at arm's length on a wall a keyboard squeezed beside a list leaves neither
usable — and anyone typing a password has already picked a network. The keyboard
sits at y=532 with height 168 (ends y=700), above the chrome rail at y=728.

**The chrome rail is hidden while the keyboard is open**, and shown again when
it closes. This is the thing that failed on hardware the first time — the rail
covered the bottom two rows of keys. `check:screen-layout` asserts the keyboard
clears the password field with an 8px gap and fits entirely above the rail.

**Four mode buttons are not optional.** LVGL's keyboard shows exactly one
character set at a time and does not cycle. Its modes are `TEXT_LOWER`,
`TEXT_UPPER`, `SPECIAL`, `NUMBER` (`SPECIAL`, not `TEXT_SPECIAL` — a wrong name
here fails validation). A WiFi password commonly needs all four, so `abc` / `ABC`
/ `#+=` / `123` call `lv_keyboard_set_mode`. Without them the keyboard is stuck
in one case and most passwords cannot be typed at all. The bind page drops the
`SPECIAL` and `NUMBER` modes — bind codes like `AB1-C23` need letters and
numbers only — and keeps `abc` / `ABC` / `Done`.

The mode parameter is an `int` index into a `lv_keyboard_mode_t[4]` rather than a
string, because ESPHome script parameters are typed.

### `auto *arr[] = {...}` cannot be deduced

`auto *row[] = {id(a), id(b)->obj};` fails with an error that names a dozen
inherited class paths and never mentions a braced list — `auto` cannot be deduced
from a braced-init-list at all. Write the type out: `lv_obj_t *row[] = {...}`.
That is fine even though `lv_obj_t` is incomplete there; a pointer to an
incomplete type may be declared, just not dereferenced.

### Connect does NOT reboot (1.7.0)

`wifi_connect` used to end in `App.safe_reboot()`. On a wall-mounted screen that
is the wrong thing in the most visible way available: it blanked the panel for
four seconds and came back, **including on every failed attempt** — which is
exactly when somebody is standing in front of it.

The reboot was never necessary. `save_wifi_sta()` already does both jobs that
matter:

- persists the credentials (`pref_.save()` then `global_preferences->sync()`), and
- registers them with the runtime network list via `set_sta()`.

All that is left is to start the association, and `retry_connect()` does that
through `start_connecting()`, which moves the state machine to
`STA_CONNECTING`.

`retry_connect()` has to be called **explicitly**. `save_wifi_sta()` ends in
`connect_soon()`, which only fires from `COOLDOWN` — and this device sits in
`WIFI_COMPONENT_STATE_AP`, because an unprovisioned screen has no `sta:` network.
From AP it is a no-op, which is the same reason the original code rebooted rather
than connected.

### The access point cannot come back by itself — and that is why a restart survives on the failure path

`WiFiComponent::loop()` restarts the fallback access point under
`if (this->has_ap() && !this->ap_setup_)`. But **`ap_setup_` is assigned exactly
once in the whole component** — in `setup_ap_config_()` — and is never cleared.
Not on `WIFI_EVENT_AP_STOP`, not anywhere else. So that branch can never be true
again after first setup and the 90-second `ap_timeout` fallback is unreachable
on this build.

That matters because starting a connection **drops** the access point:
`wifi_sta_connect_` calls `wifi_mode_(true, {})`, which is STA-only. A wrong
password therefore leaves the screen with no network *and* no access point,
retrying in silence, until somebody physically power-cycles a panel on a wall.

So `wifi_connect_watchdog` exists: if there is no association 45 s after Connect,
the device restarts. That is not a workaround, it is the recovery — at boot
`setup_wifi_ap()` starts the access point unconditionally and only declines to
leave the AP state when no station network is configured. The restart puts the
wizard back where it was, with the bad credentials still on flash to correct.

## Drawing the screen (`npm run render:setup`)

`scripts/render-setup-screen.mts` renders both setup screens to PNG from the same
parser the gate uses, in both keyboard states, into `.preview/`.

**Why this exists.** The panel is on a wall, there is no camera on this bench,
and `check:screen-layout` can prove the geometry is *sound* without being able to
say whether it is any *good*. It can check that eight networks fit inside 800px.
It cannot tell you they are readable at two metres. A gate and a preview that
parsed the YAML their own way would eventually check one thing and draw another,
so both read `scripts/lib/setup-layout.mts`.

Both states are drawn, because the interesting bugs are in the transition. The
keyboard-open state **is not in the YAML at all** — which widgets appear and
disappear lives in a lambda in `scripts.yaml`.

Geometry, colours, text and visibility are exact. **Typefaces are not** — the real
Newsreader and Archivo are baked into the firmware by the build and are not
available here, so a system serif and sans stand in at the right sizes. Every
image says so. Text wrapping is therefore indicative, not authoritative.

### What drawing it found, that no assertion could

Every one of these passed `check:screen-layout` at the time:

- The title and the instruction **overlapped** — both inside the panel, neither
  overlapping anything else.
- With the keyboard open, the raised field's **caption sat below its own box**
  and **Connect dropped out of the row** it shared with the field.
- Two of the four character-set buttons were **underneath Connect**.
- The network picker had **no explicit height**, so LVGL sized it from its own
  label and its position relative to the Scan button beside it was not knowable
  from the YAML at all. The preview drew it with no height and no outline,
  which is what a zero-height box looks like.

The first version of the keyboard raised the field into the row above it, which
required the caption, the Connect button and two hidden controls all to move
together. They collided twice anyway. **Nothing moves now** — the keyboard sits
under the password field, and opening it only changes which widgets are visible.
`check:screen-layout` asserts that directly: the toggle may contain no position
writes at all.

The arrays in the toggle are named `hidden_while_typing[]` and
`shown_while_typing[]` for the same reason. They were `row[]` and `keys[]`, and
the preview's reader silently stopped finding the first one after a rename —
which drew a screen that does not exist.

## Setup screen layout (1.6.0)

Reworked, because three things were measurably wrong rather than merely plain:

- **An 880×260 void beside the QR.** The code sat at x 40–320 with the
  credentials in a separate band at y=380, leaving the largest block of nothing
  on the screen immediately right of the one element people are told to look at
  first. The credentials now sit in that column — which is also where they
  belong, since they exist for somebody who is *not* going to scan the code.
- **Labels and values had identical voice.** "Password" and "D2P2K7FF" were both
  `font_body` at full contrast, so the pair read as a flat list. Captions are now
  `font_small` and `c_muted`; answers are `font_body` and `c_text`. That
  difference is the whole of the hierarchy and it costs nothing.
- **The instruction gave two instructions in one sentence** — "Join
  SUBWAVE-SCREEN on your phone, then pick your home network below" — and a reader
  cannot tell whether those are two steps of one route or two alternatives. They
  are alternatives. It now names both.

A hairline (`c_rule`) separates the two routes, which is structure carrying
information rather than decoration.

### The geometry is reasoned, not seen

`check:screen-layout` proves no widget falls off the panel, that the raised field
clears the keyboard, and that the controls hidden while typing are the right
ones — and eight fault shapes are verified to fail it. What no script here can
answer is whether the seven networks are legible at two metres. That still needs
a person standing in front of the screen.

## Fonts are deliberately NOT the web app's

The app uses Outfit (`app/globals.css`). The device uses Newsreader for the track
title and Archivo for everything else, and that difference is specified in
`device/design.md` with a reason: a serif display face is the voice of a radio
station, and a wall screen read from across a room is the one place that voice is
legible. Only the **colours** are shared with the app — all six day tokens match
exactly (`#06101e`, `#0d1f35`, `#dce8f5`, `#6a8ba8`, `#1a3050`, `#4e9fd4`).

Do not "fix" this by switching the fonts to Outfit.

## Gate checks

All pass (read-only, no compiler, no hardware):
- `check:panel-init` — 21/21. Verified to fail on the real fault shapes:
  appending to a model's sequence, bare-number delays, truncated sequence, wrong
  sequence file vs panel variant.
- `check:screen-layout` — 44/44. The setup screen's geometry, which is the one
  thing about this device that cannot be verified from this bench — there is no
  camera, and the panel is bolted to a wall. Verified to fail on eight fault
  shapes: a widget past y=800, the keyboard covering the field it types into,
  the closing move deleted, the resting y drifting in one file only, the Done
  button removed, a character-set mode button removed, the hide-while-typing
  dropped, and a third control landing in the row the field is raised into.
- `check:device-firmware` — 29/29
- `check:firmware-bindings` — 7/7
- `check:device-hosts` — 165/165 (was crashing on a dangling symlink
  `device/firmware/.esphome/idf/penvs/5.5.4/bin/python`; fixed `walkTs` to use
  `statSync(..., {throwIfNoEntry: false})` and skip `.esphome`)
- `check:device-capabilities` — 125/125
- `check:device-isolation` — 170/170
- `check:device-routes`, `check:device-skip`, `check:device-cutover`, etc. — pass
- `tsc --noEmit` — clean

`check:panel-init` and `check:screen-layout` are wired into `check:unit`.

### The duplicated y values are a known, checked liability

The password field's resting y (700) is declared in `setup.yaml` and written
again in `scripts.yaml` when the keyboard closes. That duplication is what makes
the keyboard/field collision possible at all, so `check:screen-layout` asserts
the two agree rather than trusting them to. **If you move the field, move it in
both files** — and the gate will tell you if you did not.

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
- **The on-screen list has not been verified by eye.** The scan, the dedupe and
  the dropdown fill are all confirmed in the log (17 results → 8 unique SSIDs,
  `home_automation` present). That the entries are legible on an 800px panel, and
  that the keyboard covers what it should, has not — there is no camera on this
  bench. `check:screen-layout` bounds the geometry; it cannot judge legibility.
  Treat the layout as reasoned, not seen.
- `panel_vendor.yaml` (old revision) exists but is not the default; it has not
  been verified on hardware.
- The light bleed around the top/right edges is physical backlight bleed on
  this panel class — content is sharp, so it's not a timing artifact. Not
  fixable in firmware.

## Ports and tooling

- **Flash:** `/dev/cu.usbmodem*` (native USB1). Re-enumerates on every reset, so
  the number changes and it is usually absent when you want to read the log.
- **Log:** `/dev/cu.usbserial-*` (CH340, 115200) via
  `device/firmware/tools/capture_log.py`. Stable port; never flash over it — it
  wedges on write at ~67%.
- AP SSID: `SUBWAVE-SCREEN`, **WPA2**, password auto-generated per device by
  `tools/gen_setup_password.py` and shown on the screen and in the QR code. On
  ESPHome's softAP default subnet while unclaimed. The wizard is reached by
  captive-portal auto-surfacing, so the address never has to be typed.
- Docker: `esphome/esphome:2026.7.0`, never `latest`.
- The vendor source tree lives in `~/Downloads/JC8012P4A1C_I_W_Y/` — not in
  this repo. `gen_jc8012p4a1_init.py` takes it as an argument; do not bake that
  path into anything.

## ESPHome external-component notes

Cost real time; all four are one-liners once known.

- **No `#ifdef USE_<COMPONENT>` guard** on an external component's header.
  ESPHome only generates those defines for CORE components, so a guard compiles
  the header to nothing and main.cpp then fails with
  `'subwave_setup_web' has not been declared`.
- **`new_Pvariable()` allocates; `cg.register_component()` registers.** Without
  the second call `setup()` never runs and nothing anywhere complains.
- **`WiFiComponent::add_scan_results_listener()` does not exist until a component
  calls `request_wifi_scan_results_listener()`** in `to_code`. The method is
  behind `#ifdef USE_WIFI_SCAN_RESULTS_LISTENERS`, and that define is generated
  from a COUNT of components that asked — not from whether anything uses the
  interface. The error names `wifi_component.h` and nothing wrong with yours.
- **`cv.use_id()`, not `cv.declare_id()`, for referencing an existing id.**
  `declare_id` *registers* a new one, so pointing it at a script that already
  exists gives `ID <name> redefined!` — which reads as a duplicate in your
  scripts file when the real fault is in the schema.
- `Script::execute()` returns void, so it cannot be passed to a
  `std::function<void()>`. Wrap it: `cg.RawExpression("[](void){ s->execute(); }")`.
  `cg.add` needs an Expression; `cg.RawStatement` is a Statement and raises
  "Object is not an expression". There is no `cg.Lambda` in 2026.7.


## Dead code that was running — and the gate that now catches it

Five features were implemented, bound, and never switched on. All of them
presented as a working system in the code and as nothing at all on the screen.
None of them logged an error, because nothing was broken; nothing ran.

- **`now_refresh()` was never called.** `parse_state_()` filled every field the
  now-playing window draws from and returned. The labels stayed on their YAML
  defaults while the log reported a successful state poll every ten seconds. A
  bug whose only symptom is the absence of a change is invisible to anyone
  watching logs, which is the only thing anybody was watching.
  - Fix: paint in `parse_state_()`, where the state landed, not on a timer. A
    timer would redraw whether or not anything changed and would keep running
    after a field was added to the struct but not to the painter.
- **`shows_refresh()` was never called.** Same cause.
- **`send_heartbeat_()` was never called.** The screen never told the station it
  was alive; the device list showed a configured, silent screen. Public wrapper
  `send_heartbeat()` added so the YAML interval can call it; 45 s interval.
- **`request_skip()` and the Skip button's `on_click`.** The only control on
  the window was a decoration. Button wired to `skip_press`; the label is NOT
  set locally, because the server sends the finished label and the device must
  not interpret a mode — that is what stops the wall and a browser disagreeing
  about whether a skip worked. The press then re-polls immediately so it does
  not read as a dead button.
- **`station_now_ms()` and `settings_clock`.** The clock was bound and never
  painted. Own one-second interval, UTC, because the screen has no timezone
  setting and a wrong guess on a clock is worse than a plainly-labelled one.
- **`idle_apply()` / `idle_touch()` / `idle_poll()` were dead.** The screen
  never dimmed, never blanked, and could not be woken. Globals declared and
  bound; nothing read them. Wired now: `on_touch` → `idle_arm`, 5 s tick →
  `idle_poll`, backlight actually dims (earlier version showed a label over a
  still-lit screen). See `device/design.md`'s idle section: stay/dim/off, 8 s
  ramp, wake touch-only, 2 s message then blank.
- **The setup screen drew over the now-playing screen on every boot.** Every
  slot in `window_stack` is created visible and stacks at 0,0, so `setup_screen`
  (last in the list) was on top. The connectivity ladder logged "all four steps
  pass" truthfully; nothing in the log said what was on the glass.
  - Fix: `boot_windows` hides the other three slots at boot. The ladder is
    correct; it was the glass that was lying.
- **Fourteen reference-firmware widgets** (`artwork_bg_panel`, `accent_overlay`,
  `track_info_panel`, `media_play_pause_button`, `station_logo`, …) sat in front
  of nothing and behind everything, behind three opaque windows, never bound,
  never referenced. `media_play_pause_button.on_click` was wired to
  `skip_toggle` — a setting, not a control. Removed; the comment in
  `display.yaml` says why.
- **`chrome_refresh()` and `poll_schedule_()` were empty stubs.** Deleted.

**The gate that now catches this class:** `scripts/check-firmware-dead-code.mts`.
It starts from entry points (ESPHome callbacks plus every name referenced in the
YAML) and walks the call graph inside the component, stripping comments and
string literals first — a comment naming a function used to count as a call,
which made the original version useless. Any function that cannot be reached is
reported. `idle_touch` sat in that report for the life of the firmware. Run
`npm run check:unit` (it is part of it) and `node --experimental-strip-types
--no-warnings scripts/check-firmware-dead-code.mts` directly.

**Mutation-tested.** Deleting the real call site for `shows_refresh` or the
`on_touch` wiring makes the gate fail. A gate that passes on a comment is not a
gate.

## Artwork — wired, not yet verified on the glass

The crossfade scaffold (`art_swap`, `art_fading`, `art_queued`, `art_primed`)
and the online images existed, but three things were missing and all three are
fixed now:

- `art_primed` was never set, so `art_swap` never fired. `on_download_finished`
  on `art_in_image` now sets it and triggers the swap when one is queued.
- `online_image` had no auth header while the art route is bearer-protected, so
  every fetch 401'd. Both online images now send
  `Authorization: Bearer <token>` via a templated header read at fetch time.
- The cover URL never changed: the server names a new cover in state and nothing
  applied it. `parse_state_()` now queues the path, and the one-second tick
  joins it to the app base URL and calls `set_url` + `update` on `art_in_image`.

`request_artwork()` is gone — the online image does the fetch itself, with auth,
so the old authenticated-fetch-into-a-discarded-buffer is dead code and was
removed rather than kept alive. The initial URL is still the deliberate 404.

What is NOT verified: the crossfade pointer swap. `art_swap` swaps the
`art_out`/`art_in` widget pointers but the online_image components keep their
identities, so a second cover fetched into `art_in_image` lands in whichever
widget currently holds the `art_in` name. That is the part to watch on the
glass. The fetch, decode, auth and trigger paths are all complete.
