#!/bin/bash
# Wait for the panel to come back, then finish the flash.
#
# WHY. The chip is wedged in download mode after an interrupted write, and the
# only way out is a physical power cycle — which nobody can do from a terminal.
# This polls until esptool can actually talk to the chip again, then flashes and
# verifies, so unplugging the panel is the last action anyone has to take.
#
# Safe to run and leave. It writes nothing until the chip answers, and it only
# writes to the four known offsets.
set -u

D=/private/var/folders/bs/t1sc9q812ksgptvxsysd28sw0000gn/T/opencode
ESPTOOL=$D/esp2/bin/esptool
PORT=/dev/cu.usbserial-214220
BUILD=/Users/scott/GitHub/subwave-listener/device/firmware/builds/.esphome/build/subwave-screen/build

# 115200, not 921600. The CH340 uploads the stub and then drops the link at the
# higher rate with "Unable to verify flash chip connection".
BAUD=115200

echo "Waiting for $PORT to answer. Unplug and replug the panel's USB."
echo "(Ctrl-C to stop.)"

attempt=0
until $ESPTOOL --chip esp32p4 -p "$PORT" -b $BAUD chip-id >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ $((attempt % 30)) -eq 0 ]; then
    echo "  ...still waiting ($((attempt * 2))s)"
  fi
  sleep 2
done

echo
echo "Chip is talking. Flashing..."

cd "$BUILD" || exit 1
$ESPTOOL --chip esp32p4 -p "$PORT" -b $BAUD write-flash \
  --flash-mode dio --flash-freq 40m --flash-size 16MB \
  0x2000 bootloader/bootloader.bin \
  0x10000 subwave-screen.bin \
  0x8000 partition_table/partition-table.bin \
  0x9000 ota_data_initial.bin
status=$?

echo
if [ $status -eq 0 ]; then
  echo "FLASH OK — the panel should now be running the screen."
else
  echo "FLASH FAILED (exit $status)."
fi
exit $status
