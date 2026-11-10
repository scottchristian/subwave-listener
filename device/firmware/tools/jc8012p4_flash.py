#!/usr/bin/env python3
# jc8012p4_flash.py — enter ROM download mode without pressing BOOT button.
# Usage: python3 jc8012p4_flash.py <port> <esptool args...>
#   e.g. python3 jc8012p4_flash.py /dev/cu.usbserial-1234 --chip esp32p4 chip_id
#        python3 jc8012p4_flash.py /dev/cu.usbserial-1234 --chip esp32p4 write_flash 0x0 app.bin
# Requires: pip install pyserial esptool
#
# Based on vendor docs: CH340 DTR→GPIO35, RTS→CHIP_PU auto-download circuit.
# DTR=True pulls GPIO35 low (strap), RTS=True pulls CHIP_PU low (reset),
import glob, os, serial, subprocess, sys, time

repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
default_bin = os.path.join(
    repo_root,
    "device/firmware/builds/.esphome/build/subwave-screen/build/firmware.factory.bin",
)

PORT = None
BAUD = "115200"
ARGS = []

i = 1
while i < len(sys.argv):
    arg = sys.argv[i]
    if arg in ("--port", "-p") and i + 1 < len(sys.argv):
        PORT = sys.argv[i + 1]
        i += 2
    elif arg in ("--baud", "-b") and i + 1 < len(sys.argv):
        BAUD = sys.argv[i + 1]
        i += 2
    elif arg.startswith("/dev/"):
        PORT = arg
        i += 1
    else:
        ARGS.append(arg)
        i += 1

if not PORT:
    ttl = sorted(glob.glob("/dev/cu.usbserial-*"))
    if ttl:
        PORT = ttl[0]
    else:
        PORT = "/dev/cu.usbserial-214220"

# Optional strap toggle into download mode
try:
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
    time.sleep(0.1)
    s.close()
except Exception:
    pass

site_packages = os.path.join(
    repo_root,
    "device/firmware/.esphome/idf/penvs/5.5.4/lib/python3.14/site-packages",
)
env = dict(os.environ)
if os.path.exists(site_packages):
    env["PYTHONPATH"] = site_packages

python_bin = "/opt/homebrew/bin/python3.14" if os.path.exists("/opt/homebrew/bin/python3.14") else sys.executable

cmd = [
    python_bin, "-m", "esptool",
    "--port", PORT,
    "--baud", BAUD,
]

if "--chip" not in ARGS:
    cmd.extend(["--chip", "esp32p4"])

if "--before" not in ARGS:
    cmd.extend(["--before", "default_reset"])

if "--after" not in ARGS:
    cmd.extend(["--after", "hard_reset"])

subcommands = {"write_flash", "chip_id", "flash_id", "read_mac", "erase_flash", "run", "verify_flash"}
has_subcommand = any(a in subcommands for a in ARGS)

if not has_subcommand:
    cmd.extend([
        "write_flash", "-z",
        "--flash_mode", "dio",
        "--flash_freq", "40m",
        "--flash_size", "16MB",
        "0x0", default_bin,
    ])

cmd.extend(ARGS)

print(f"Flashing {PORT} at {BAUD} baud...", flush=True)
rc = subprocess.call(cmd, env=env)

# Release strap and reset back into app if needed
try:
    s2 = serial.Serial(PORT, 115200, timeout=0.2)
    s2.dtr = False
    s2.rts = True
    time.sleep(0.2)
    s2.rts = False
    s2.close()
except Exception:
    pass

sys.exit(rc)
