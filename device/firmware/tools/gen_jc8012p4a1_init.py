#!/usr/bin/env python3
"""Generate common/jc8012p4a1_init.yaml from the vendor's own panel init sequence.

WHY THIS EXISTS
---------------
ESPHome ships an init sequence for `model: JC8012P4A1` that is byte-for-byte the
vendor's list, minus the last five commands:

    {0xE0, 0x00, 1,   0},   <- back to page 0
    {0x11, 0x00, 1,   0},   <- DCS SLEEP OUT
    {0x29, 0x00, 1,   5},   <- DCS DISPLAY ON     (5 ms settle)
    {0x11, 0x00, 1, 120},   <- DCS SLEEP OUT again (120 ms settle)
    {0x35, 0x00, 1,   0},   <- DCS TEON

The generated file is the vendor's full 198-command list in ESPHome's YAML
`init_sequence` form. It is committed as ground truth to diff against, NOT
currently wired into display.yaml — see the comment there for why using it made
things worse rather than better (`init_sequence` appends rather than replaces, so
supplying the whole list re-runs every register write and stalls ~9s on an ACK
timeout, which is a boot loop against the 5s task watchdog).

That is worth stating plainly: this file is a reference, not a fix.

USAGE
-----
    python3 tools/gen_jc8012p4a1_init.py <path-to-jc8012p4a1.cc> <output.yaml>

The vendor source lives inside the Guition IDF demo tree that ships with the
board, at
    <demo>/xiaozhi-esp32-main/main/boards/guition-jc8012p4a1/jc8012p4a1.cc
Pass it in explicitly rather than hardcoding a path: it lives in someone's
Downloads folder and that is not a location to bake into a repository.

Run with the ESPHome image so the cross-check against ESPHome's model list works:

    docker run --rm -i --entrypoint python3 \
      -v "$PWD:/config" -v /path/to/demo:/vendor:ro \
      esphome/esphome:2026.7.0 \
      /config/tools/gen_jc8012p4a1_init.py \
      /vendor/.../jc8012p4a1.cc /config/common/jc8012p4a1_init.yaml
"""

import re
import sys


def parse_vendor_commands(src_path):
    """Pull (cmd, data, delay_ms) triples out of the vendor's lcd_cmd[] array."""
    text = open(src_path).read()
    start = text.index("lcd_cmd[] = {")
    end = text.index("\n};", start)

    # The struct is {cmd, {data}, data_bytes, delay_ms}. The first two are hex
    # literals and the last two are decimal, so a plain "grab every 0xNN" pass
    # finds only two numbers per line and silently drops everything.
    entry = re.compile(
        r"0x([0-9A-Fa-f]{2}),.*?\{0x([0-9A-Fa-f]{2})\}\s*,\s*(\d+)\s*,\s*(\d+)\s*\}"
    )

    cmds = []
    for line in text[start:end].splitlines():
        m = entry.search(line)
        if not m:
            continue
        cmd = int(m.group(1), 16)
        data = int(m.group(2), 16)
        nbytes = int(m.group(3))
        delay = int(m.group(4))
        assert nbytes == 1, "unexpected command width: %s" % line
        cmds.append((cmd, data, delay))
    return cmds


def cross_check(cmds):
    """Prove ESPHome's copy still matches the vendor's, so the diff stays honest."""
    from esphome.components.mipi_dsi.display import MODELS

    esp = [(g[0], g[1] if len(g) > 1 else None) for g in MODELS["JC8012P4A1"].initsequence]
    print("ESPHome ships %d commands, vendor has %d" % (len(esp), len(cmds)))

    # Find the first divergence, then check whether everything after it lines up
    # with a constant offset. A constant offset means ESPHome simply OMITS a
    # command rather than reordering anything, which is a far more precise thing
    # to report than "the lists differ".
    first = next((i for i in range(min(len(esp), len(cmds))) if esp[i] != (cmds[i][0], cmds[i][1])), None)
    if first is None:
        print("  shared prefix identical")
        return
    print("  first divergence at index %d: ESPHome %s vs vendor 0x%02X,0x%02X"
          % (first, esp[first], cmds[first][0], cmds[first][1]))

    offset = None
    for shift in range(1, 8):
        if all(esp[i] == (cmds[i + shift][0], cmds[i + shift][1]) for i in range(first, len(esp) - shift)):
            offset = shift
            break
    if offset:
        print("  ESPHome[%d:] == vendor[%d:] — the lists are the same list with"
              " %d command(s) omitted, not reordered" % (first, first + offset, offset))
    print("  vendor-only tail: %s" % [(hex(c), hex(d), t) for c, d, t in cmds[len(esp):]])


HEADER = """\
# The panel init sequence for the JC8012P4A1, verbatim from the vendor.
#
# GENERATED — do not hand-edit. Regenerate with tools/gen_jc8012p4a1_init.py,
# which prints the diff against ESPHome's copy when it runs.
#
# This is a REFERENCE, not a fix. ESPHome's own model list for this panel is the
# vendor's list minus SIX commands, verified by index-aligned comparison:
#
#   - one from the middle of the driver-IC block, vendor index 32:
#         {0x4A, 0x35, 1, 0}
#     Everything from there on is offset by exactly one, so the two lists are
#     otherwise identical — not a rearrangement.
#
#   - the five that wake the panel, at the end:
#         {0xE0, 0x00, 1,   0},   <- back to page 0
#         {0x11, 0x00, 1,   0},   <- DCS SLEEP OUT
#         {0x29, 0x00, 1,   5},   <- DCS DISPLAY ON     (5 ms settle)
#         {0x11, 0x00, 1, 120},   <- DCS SLPOUT again    (120 ms settle)
#         {0x35, 0x00, 1,   0},   <- DCS TEON
#
# Missing commands are suggestive but not conclusive. The tail is not the bug:
# ESPHome already appends what the panel needs to wake up (get_sequence() in
# components/mipi/__init__.py adds PIXFMT, MADCTL, INVOFF, then delay(0) + SLPOUT
# + delay(10) + DISPON + delay(10)). The mid-sequence omission is the more
# interesting one and cannot be patched by appending, because by the end of the
# sequence the panel is in a different register page than index 32 expects.
#
# Why this is not simply wired into display.yaml: `init_sequence` APPENDS to the
# model's sequence rather than replacing it, so supplying this whole list sends
# all 391 commands. The duplicate run stalls ~9s inside
# esp_lcd_panel_io_tx_param waiting on an ACK that never arrives, which is a 12.8s
# setup against a 5s task watchdog: an instant boot loop. Measured, not theorised.
#
# The way to actually USE this sequence is `model: CUSTOM`, where the model
# contributes no default sequence and `init_sequence` becomes the whole thing.
# See common/panel_vendor.yaml, which does exactly that - and which is,
# functionally, the vendor's own jd9365 driver: in esp_lcd_jd9365.c line 123 the
# driver saves the generic esp_lcd_new_panel_dpi() panel's own init and calls it
# again at line 493. So a blank panel under that config is evidence about the
# hardware, not about missing driver support, and porting jd9365 would not be the
# fix.
"""


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)

    src, out = sys.argv[1], sys.argv[2]
    print("reading vendor source: %s" % src)
    cmds = parse_vendor_commands(src)
    print("parsed %d commands" % len(cmds))
    cross_check(cmds)

    lines = []
    for cmd, data, delay in cmds:
        lines.append("  - [0x%02X, 0x%02X]" % (cmd, data))
        if delay:
            # The unit is REQUIRED. `- delay 5` fails validation with a bare
            # "Unknown value ''" from the time-period parser.
            lines.append("  - delay %dms" % delay)

    open(out, "w").write(HEADER + "\n".join(lines) + "\n")
    print("wrote %s (%d lines)" % (out, len(lines)))


if __name__ == "__main__":
    main()
