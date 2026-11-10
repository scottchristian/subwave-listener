# GSL3680 external component

Vendored from `kvj/esphome@dca6f3eed895ee03b894a7d172855c919ee7eda1`.

This copy keeps the 10-inch P4 touchscreen driver in the same release stream as the dashboard firmware so crash fixes can be shipped without waiting for the upstream branch.

License details from the source repository are included in `LICENSE.md`.

## Maintenance notes

- Treat `kvj/esphome@dca6f3eed895ee03b894a7d172855c919ee7eda1` as the upstream
  baseline before updating this component.
- Preserve the local startup retry behavior in `gsl3680.cpp`: after the initial
  configuration read, the driver retries firmware load once with a touchscreen
  power cycle if the RAM status check fails.
- The current touch reporting path reads two touch points and clamps larger
  reported counts to those two points. Do not change that behavior without
  testing multi-touch and single-touch on the physical panel.
- After changing the driver, test a real supported GSL3680 device for boot
  detection, tap accuracy, drag/scroll behavior, rotation handling, wake from
  screen-off, and recovery after a warm reboot.
- Keep `gsl3680_firmware.h` and `gsl_point_id.*` together with driver changes;
  they are part of the same vendored touchscreen behavior.
