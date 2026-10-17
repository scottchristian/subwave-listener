#!/usr/bin/env python3
"""Capture a boot log from the SUB/WAVE screen.

WHY THIS SCRIPT EXISTS.

The panel exposes two USB ports and they are not interchangeable:

  /dev/cu.usbmodem*    the ESP32-P4's own USB. Fast (full image in ~40s) but
                       DISAPPEARS the moment the chip resets, because the
                       device re-enumerates and macOS hands it a new number. A
                       flash started on this port can lose the port mid-write.

  /dev/cu.usbserial-*  a CH340 USB-TTL bridge wired to the auto-download
                       circuit. The port is stable, but the bridge wedges
                       around 67% of a write and never recovers on its own.

So: FLASH on usbmodem, READ on usbserial.

THE DTR/RTS LINES ARE THE AUTO-DOWNLOAD CIRCUIT, NOT A PLAIN RESET.

On the CH340 port, DTR and RTS are the classic two-transistor EN/IO0 download
latch. Asserting the wrong combination does not fail loudly: it puts the chip in
ROM download mode, and the log shows four lines of `ESP-ROM` and `waiting for
download` and then silence. That reads as a dead device, not as a mis-sequenced
reset, and it costs a reboot every time.

Hold DTR low (run the app), pulse RTS high (reset) and release. See the comment
at the sequencing site for the full truth table.

Usage:  python3 tools/capture_log.py [seconds]
"""
import glob
import os
import sys
import time

import serial


def find_port():
    """Prefer the CH340. The native USB port renumbers itself on every reset."""
    ttl = sorted(glob.glob("/dev/cu.usbserial-*"))
    if ttl:
        return ttl[0]
    native = sorted(glob.glob("/dev/cu.usbmodem*"))
    if native:
        return native[0]
    sys.exit("No serial port found. Check the cable.")


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 45
    port = find_port()
    print(f"# port {port}, capturing {seconds}s", file=sys.stderr)

    s = serial.Serial(port, 115200, timeout=0.3)

    # THE DTR/RTS SEQUENCE, AND WHY IT IS ONLY TWO STEPS.
    #
    # The CH340's auto-download circuit cross-couples the two lines through a
    # transistor pair:
    #
    #     RTS high  -> EN low    (reset)
    #     DTR low   -> IO0 high  (run the app)
    #     DTR high  -> IO0 low   (enter ROM download mode)
    #
    # So the reset-into-the-app sequence is: hold DTR LOW, pulse RTS high and
    # release it. That is all.
    #
    # The tempting three-step version — DTR low, then DTR high with RTS low, then
    # DTR low again — puts IO0 LOW while EN is HIGH, which is download mode. The
    # log then shows four lines of `ESP-ROM` and `waiting for download` and
    # nothing else, forever, and it reads like a dead device rather than a
    # mis-sequenced reset.
    s.dtr = False   # IO0 high: run, don't download
    s.rts = True    # EN low: reset
    time.sleep(0.2)
    s.rts = False   # EN high: release the reset
    time.sleep(0.8)
    s.reset_input_buffer()

    start = time.time()
    chunks = []
    while time.time() - start < seconds:
        data = s.read(4096)
        if data:
            chunks.append(data.decode("utf-8", "replace"))
    s.close()

    text = "".join(chunks)
    # Strip the ANSI colour ESPHome's logger emits. It is unreadable in a
    # terminal scrollback and useless to grep.
    import re

    sys.stdout.write(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text))


if __name__ == "__main__":
    main()
