#!/usr/bin/env python3
# jc8012p4_flash.py — enter ROM download mode without pressing BOOT button.
# Usage: python3 jc8012p4_flash.py <port> <esptool args...>
#   e.g. python3 jc8012p4_flash.py /dev/cu.usbserial-1234 --chip esp32p4 chip_id
#        python3 jc8012p4_flash.py /dev/cu.usbserial-1234 --chip esp32p4 write_flash 0x0 app.bin
# Requires: pip install pyserial esptool
#
# Based on vendor docs: CH340 DTR→GPIO35, RTS→CHIP_PU auto-download circuit.
# DTR=True pulls GPIO35 low (strap), RTS=True pulls CHIP_PU low (reset),
# then RTS=False rises CHIP_PU while GPIO35 still low → ROM download mode.
import serial, subprocess, sys, time

PORT = sys.argv[1]
ARGS = sys.argv[2:]
if not ARGS:
    sys.exit("missing esptool args")

s = serial.Serial(PORT, 115200, timeout=0.2)

# Idle: both high = CHIP_PU high, GPIO35 high → chip runs app
s.dtr = False
s.rts = False
time.sleep(0.05)

# Pull GPIO35 low via DTR (strap for download mode)
s.dtr = True
time.sleep(0.05)

# Pull CHIP_PU low via RTS to reset the chip
s.rts = True
time.sleep(0.20)

# Release CHIP_PU while GPIO35 still low → ROM download mode
s.rts = False

rc = subprocess.call([
    "python3", "-m", "esptool",
    "--port", PORT,
    "--before", "no-reset",
    "--after", "hard-reset",
] + ARGS)

# Release strap
s.dtr = False
s.rts = True
time.sleep(0.2)
s.rts = False
s.close()
sys.exit(rc)
