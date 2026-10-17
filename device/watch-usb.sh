#!/bin/bash
# Watch for a wall screen appearing on USB.
#
# Run this in a terminal, LEAVE IT RUNNING, and then try things: a different
# USB port, a different cable, a power cycle. It prints the moment something
# changes, so you do not have to keep asking anyone to re-check.
#
#   ./device/watch-usb.sh
#
# It looks for the three things that matter, in order of how likely they are:
#
#   1. /dev/cu.usbmodem*   the ESP32-P4's NATIVE USB (USB Serial/JTAG).
#                          Needs no driver on macOS and appears immediately.
#                          This is what you want.
#   2. vendor 0x303a       Espressif. Same thing, seen the other way.
#   3. /dev/cu.usbserial*  a CP2102 / CH340 USB-UART BRIDGE. Not native USB:
#                          some boards only expose a UART header, and this is
#                          what shows up instead. Also fine — esptool works
#                          with it, you just flash at a lower baud.

set -u

snapshot() {
  {
    ls /dev/cu.* 2>/dev/null
    ioreg -p IOUSB -l 2>/dev/null | grep -E '"(idVendor|idProduct|USB Product Name)"'
    # Trailing whitespace is stripped because ioreg's indentation shifts between
    # calls, and a snapshot that differs from itself produces a phantom "something
    # changed" — which is worse than no watcher at all, because it teaches you to
    # ignore the output that matters.
  } | sed 's/[[:space:]]*$//' | sort
}

prev=$(snapshot)

echo "Watching for USB changes. Try a port, a cable, or a power cycle."
echo "Nothing to do until something prints. Ctrl-C to stop."
echo

while true; do
  sleep 1
  cur=$(snapshot)

  if [ "$cur" != "$prev" ]; then
    echo "─────────────────────────────────────────────────────────────"
    date "+  %H:%M:%S  something changed"

    # Native USB first — the happy path.
    native=$(ls /dev/cu.usbmodem* 2>/dev/null)
    if [ -n "$native" ]; then
      echo "  ✅ NATIVE USB SERIAL: $native"
      echo "     Use it directly:"
      echo "       esphome run device/firmware/builds/subwave-jc8012p4a1.yaml --device $native"
    fi

    # A UART bridge — also usable, just different.
    uart=$(ls /dev/cu.usbserial* /dev/cu.wchusbserial* /dev/cu.SLAB* 2>/dev/null)
    if [ -n "$uart" ]; then
      echo "  ✅ USB-UART BRIDGE: $uart"
      echo "     Flash at a lower baud — native USB is much faster:"
      echo "       esptool.py --chip esp32p4 -b 115200 -p $uart write_flash 0x0 <factory.bin>"
    fi

    # Anything Espressif, whatever it enumerated as.
    if ioreg -p IOUSB -l 2>/dev/null | grep -q 303a; then
      echo "  ✅ Espressif device (vendor 0x303a) is present"
    fi

    # Name anything that appeared, so a new device is identifiable even if it
    # is not one of the three above.
    echo "  USB devices now:"
    ioreg -p IOUSB -l 2>/dev/null | grep '"USB Product Name"' | sed 's/^ */    /'
    echo "  Serial ports now:"
    ls /dev/cu.* 2>/dev/null | sed 's/^/    /'

    if [ -z "$native" ] && [ -z "$uart" ]; then
      echo
      echo "  ⚠️  Something connected, but not as a serial device."
      echo "     That usually means the port carries POWER ONLY."
      echo "     On this panel, try the other USB-C ports in turn, and check"
      echo "     that the screen's backlight comes on — if it does not, the"
      echo "     board is not being powered at all and no port will enumerate."
    fi

    echo
    prev=$cur
  fi
done