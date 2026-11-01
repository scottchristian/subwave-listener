#!/usr/bin/env python3
"""Interactive touch screen responsiveness and latency diagnostic tool for SUB/WAVE.

Connects to the device serial port WITHOUT resetting the board, allowing you to
interactively tap the screen and immediately see:
  - Exactly when touch events register and their screen coordinates
  - When the main loop stalls and drops touch input
  - Which specific function/operation blocked the thread
  - Dual-core CPU and memory stats
"""

import glob
import os
import re
import sys
import time

try:
    import serial
except ImportError:
    sys.exit("pyserial required. Run: pip install pyserial")

# ANSI color codes
RESET = "\033[0m"
BOLD = "\033[1m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
DIM = "\033[2m"

def find_port():
    ttl = sorted(glob.glob("/dev/cu.usbserial-*"))
    if ttl:
        return ttl[0]
    native = sorted(glob.glob("/dev/cu.usbmodem*"))
    if native:
        return native[0]
    return "/dev/cu.usbserial-214220"

def main():
    port = find_port()
    duration = None
    for arg in sys.argv[1:]:
        if arg.isdigit():
            duration = int(arg)
        elif arg.startswith("/dev/"):
            port = arg

    print(f"{BOLD}{CYAN}" + "=" * 68)
    print("        SUB/WAVE Touchscreen Real-Time Diagnostic Tool")
    print("=" * 68 + RESET)
    if duration:
        print(f"Connecting to {port} (monitoring for {duration}s)...", flush=True)
    else:
        print(f"Connecting to {port} (live interactive mode)...", flush=True)

    try:
        ser = serial.Serial()
        ser.port = port
        ser.baudrate = 115200
        ser.timeout = 0.2
        # Keep DTR/RTS false so CH340 does NOT reboot the ESP32!
        ser.dtr = False
        ser.rts = False
        ser.open()
    except Exception as e:
        sys.exit(f"{RED}Failed to open {port}: {e}{RESET}")

    print(f"{GREEN}Connected! Running live monitor. Tap screen to test.{RESET}\n")
    print("INSTRUCTIONS:")
    print("  1. Tap the screen (buttons, sliders, or empty space).")
    print("  2. Watch for GREEN touch lines — shows hardware detection & coordinates.")
    print("  3. If touch does not respond, watch for RED STALL warnings.")
    print("  4. Press Ctrl+C at any time for summary diagnostic report.\n")
    print(f"{DIM}{'-' * 68}{RESET}")

    t_start = time.time()
    taps_count = 0
    stalls_count = 0
    max_stall_ms = 0
    last_blocker = "none"

    try:
        while duration is None or (time.time() - t_start < duration):
            raw_line = ser.readline()
            if not raw_line:
                continue
            line = raw_line.decode("utf-8", "replace").strip()
            if not line:
                continue

            now_str = time.strftime("%H:%M:%S")

            # 1. Touch event
            if "subwave.touch" in line and "Touch down at" in line:
                taps_count += 1
                coords = re.search(r"\((\d+),\s*(\d+)\)", line)
                coord_str = coords.group(0) if coords else ""
                print(f"[{now_str}] {BOLD}{GREEN}>>> [TOUCH DOWN] Tap #{taps_count} at {coord_str}{RESET}")

            elif "subwave.touch" in line and "Touch release" in line:
                print(f"[{now_str}] {CYAN}<<< [TOUCH RELEASE] Finger lifted{RESET}")

            # 2. Blocking operation
            elif "subwave.block" in line or "blocked main thread" in line:
                m = re.search(r"([A-Za-z0-9_:\(\)/.-]+)\s+blocked main thread for\s+(\d+)\s*ms", line)
                if m:
                    last_blocker = m.group(1)
                    ms = int(m.group(2))
                    print(f"[{now_str}] {YELLOW}[!] BLOCKING OP: '{last_blocker}' held thread for {ms} ms{RESET}")
                else:
                    print(f"[{now_str}] {YELLOW}{line}{RESET}")

            # 3. Main loop stall
            elif "Main loop stall:" in line or "subwave.stall" in line:
                stalls_count += 1
                m = re.search(r"Main loop stall:\s*(\d+)\s*ms", line)
                ms = int(m.group(1)) if m else 0
                if ms > max_stall_ms:
                    max_stall_ms = ms
                print(f"[{now_str}] {BOLD}{RED}!!! [STALL DETECTED] Main thread frozen for {ms} ms! (Touch was disabled){RESET}")

            # 4. Stuck IRQ pin
            elif "stuck LOW" in line:
                print(f"[{now_str}] {BOLD}{MAGENTA}[!] HARDWARE IRQ ALERT: {line}{RESET}")

            # 5. Periodic Stats
            elif "STATS: CPU" in line:
                m = re.search(r"CPU \[C0:\s*(\d+)%,\s*C1:\s*(\d+)%\].*?Loops:\s*(\d+)/s,\s*MaxLag:\s*(\d+)ms", line)
                if m:
                    c0, c1, loops, lag = m.groups()
                    print(f"[{now_str}] {DIM}[STATS] CPU C0:{c0}% C1:{c1}% | Loop: {loops}/s | Lag: {lag}ms{RESET}")
                else:
                    print(f"[{now_str}] {DIM}{line}{RESET}")

            # 6. Idle touch wake
            elif "Idle touch: wake" in line:
                print(f"[{now_str}] {GREEN}    [WAKE] Screen wake timer re-armed{RESET}")

    except KeyboardInterrupt:
        pass
    finally:
        ser.close()

    elapsed = int(time.time() - t_start)
    print(f"\n{BOLD}{CYAN}" + "=" * 68)
    print(f"               TOUCHSCREEN TEST SUMMARY ({elapsed}s)")
    print("=" * 68 + RESET)
    print(f"  Total Taps Registered:  {GREEN}{taps_count}{RESET}")
    print(f"  Total Stalls (>250ms):  {RED if stalls_count > 0 else GREEN}{stalls_count}{RESET}")
    print(f"  Worst Stall Duration:   {RED if max_stall_ms > 500 else GREEN}{max_stall_ms} ms{RESET}")
    if stalls_count > 0:
        print(f"  Last Known Blocker:     {YELLOW}{last_blocker}{RESET}")
        print(f"\n{BOLD}DIAGNOSIS:{RESET}")
        print("  Touch unresponsive moments are caused by synchronous network calls")
        print("  blocking the main loop. When the loop stalls, touch polling is suspended.")
    else:
        print(f"\n{BOLD}DIAGNOSIS:{RESET}")
        print("  No major stalls detected during this session. Responsiveness healthy.")
    print(f"{BOLD}{CYAN}=" * 68 + RESET)

if __name__ == "__main__":
    main()

