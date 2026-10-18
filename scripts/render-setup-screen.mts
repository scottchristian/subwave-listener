// Draws the setup screen so it can be looked at.
//
// WHY. The panel is bolted to a wall, there is no camera on this bench, and
// check:screen-layout can prove the geometry is SOUND — nothing off the edge,
// the raised field clears the keyboard, the right controls hide — without being
// able to say whether the result is any good. It can check that eight networks
// fit inside 800 pixels. It cannot tell you they are readable at two metres.
//
// So this draws the same numbers the gate checks. Same parser, same source, one
// reading of the YAML — a gate and a preview that parsed the file their own way
// would eventually check one thing and draw another, which is worse than having
// neither.
//
// BOTH STATES ARE DRAWN, because the interesting bugs are in the transition. The
// keyboard-open state is not in the YAML at all: the field's raised position and
// the set of controls that disappear live in a lambda in scripts.yaml. A preview
// that only drew the closed state would draw the screen nobody sees.
//
// WHAT IS EXACT AND WHAT IS NOT. Geometry, colours, text and visibility are
// taken from the YAML and are exact. TYPEFACES ARE NOT — the real Newsreader and
// Archivo are baked into the firmware by the build and are not available here, so
// a system serif and sans stand in at the right sizes. Every image says so. That
// means line-breaking and text overflow are indicative, not authoritative: the
// renderer draws the label on one line where LVGL would wrap it.
//
// Run: npm run render:setup
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  PANEL_H,
  PANEL_W,
  SCREENS,
  closedState,
  openState,
  parseKeyboardState,
  parseWidgets,
  screenPath,
  type Widget,
} from "./lib/setup-layout.mts";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, ".preview");

/** LVGL font sizes from display.yaml, and which face each stands in for. */
const FONT_SIZE: Record<string, { px: number; serif: boolean }> = {
  font_title: { px: 48, serif: true },
  font_body: { px: 26, serif: false },
  font_small: { px: 18, serif: false },
};

/** The font stack for a widget. Single quotes inside, so the SVG attribute is
 *  never built by nesting double quotes inside a double-quoted attribute — which
 *  produced an XML parse error rather than a wrong-looking picture. */
function familyOf(w: Widget): string {
  const font = FONT_SIZE[w.textFont ?? "font_body"] ?? { px: 20, serif: false };
  return font.serif ? "Georgia, 'Times New Roman', serif" : "Helvetica, Arial, sans-serif";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The QR code is drawn as a placeholder, not encoded.
 *
 * Encoding it properly is not the point, and a placeholder that says so is more
 * useful than a real code would be: a real code would let somebody scan this
 * image and think it provisions something. Its FOOTPRINT is the point — a
 * 280px square is the thing being checked for collision.
 */
function qrcodeBlock(w: Widget): string {
  const size = w.w ?? w.h ?? 280;
  const x = w.x ?? 0;
  const y = w.y ?? 0;
  const modules = 21;
  const cell = size / modules;
  let cells = "";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      // Finder patterns in three corners, plus a deterministic interior so it
      // reads as a code at a glance rather than as a plain grid.
      const finder =
        (r < 7 && c < 7) || (r < 7 && c >= modules - 7) || (r >= modules - 7 && c < 7);
      const on = finder ? (r % 6 === 0 || c % 6 === 0 || (r > 1 && r < 5 && c > 1 && c < 5)) : (r * 7 + c * 3) % 5 < 2;
      if (on) {
        cells += `<rect x="${(x + c * cell).toFixed(1)}" y="${(y + r * cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="${w.bgColor ?? "#0b1a2b"}"/>`;
      }
    }
  }
  return `${cells}<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="#c8a76a" stroke-width="1" stroke-dasharray="4 4"/>`;
}

/** A LVGL keyboard, drawn as the key grid it is. */
function keyboardBlock(w: Widget): string {
  const x = w.x ?? 0;
  const y = w.y ?? 0;
  const width = w.w ?? PANEL_W;
  const height = w.h ?? 240;

  const rows = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", "?"],
    ["⇧", "z", "x", "c", "v", "b", "n", "m", "⌫", "↵"],
  ];

  let out = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#0d1f35"/>`;
  const pad = 8;
  const rowH = (height - pad * 2) / rows.length;
  rows.forEach((keys, r) => {
    const kw = (width - pad * 2) / keys.length;
    keys.forEach((k, c) => {
      const kx = x + pad + c * kw;
      const ky = y + pad + r * rowH;
      out += `<rect x="${kx + 2}" y="${ky + 2}" width="${kw - 4}" height="${rowH - 4}" rx="6" fill="#16304c"/>`;
      out += `<text x="${(kx + kw / 2).toFixed(1)}" y="${(ky + rowH / 2 + 7).toFixed(1)}" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#dce8f5" text-anchor="middle">${esc(k)}</text>`;
    });
  });
  return out;
}

function widgetSvg(w: Widget): string {
  // HIDDEN WIDGETS ARE STILL DRAWN, as outlines.
  //
  // Not drawing them made the preview lie about the screen. Both artwork
  // widgets are `hidden: true` until a cover arrives, so the now-playing window
  // rendered as an empty right-hand half with nothing to say a 520-square cover
  // belongs there — which is exactly the half of the layout most worth checking.
  //
  // A dashed outline says "this is empty right now, and this is the space it
  // will occupy", which is both true and enough to catch an overlap.
  if (w.hidden) {
    const x = w.x ?? 0;
    const y = w.y ?? 0;
    const width = w.w ?? 0;
    const height = w.h ?? 0;
    if (width === 0 || height === 0) return "";

    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${w.radius ?? 0}" fill="none" stroke="#2f4a6b" stroke-width="2" stroke-dasharray="8 6"/>`
      + `<text x="${x + width / 2}" y="${y + height / 2 + 5}" font-family="${familyOf(w)}" font-size="15" fill="#3c5c7d" text-anchor="middle">${esc(w.id)} (hidden)</text>`;
  }

  const x = w.x ?? 0;
  const y = w.y ?? 0;
  const width = w.w ?? 0;
  const height = w.h ?? 0;
  const radius = w.radius ?? 0;
  const font = FONT_SIZE[w.textFont ?? "font_body"] ?? { px: 20, serif: false };
  const family = font.serif ? "Georgia, Times, serif" : "Helvetica, Arial, sans-serif";

  let out = "";

  switch (w.kind) {
    case "qrcode":
      return qrcodeBlock(w);

    case "keyboard":
      return keyboardBlock(w);

    case "button": {
      out += `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${w.bgColor ?? "#0d1f35"}"/>`;
      out += `<text x="${x + width / 2}" y="${y + height / 2 + 8}" font-family="${family}" font-size="${font.px}" fill="${w.textColor ?? "#dce8f5"}" text-anchor="middle">${esc(w.text ?? "")}</text>`;
      return out;
    }

    case "textarea": {
      out += `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="#0d1f35" stroke="#1a3050" stroke-width="2"/>`;
      const hint = w.text ?? "Network password";
      out += `<text x="${x + 14}" y="${y + height / 2 + 8}" font-family="${family}" font-size="${font.px}" fill="#6a8ba8">${esc(hint)}</text>`;
      return out;
    }

    case "dropdown": {
      out += `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#0d1f35" stroke="#1a3050" stroke-width="2"/>`;
      const first = w.text ?? "Scanning…";
      out += `<text x="${x + 14}" y="${y + height / 2 + 8}" font-family="${family}" font-size="${font.px}" fill="#dce8f5">${esc(first)}</text>`;
      out += `<text x="${x + width - 20}" y="${y + height / 2 + 8}" font-family="${family}" font-size="${font.px}" fill="#6a8ba8" text-anchor="end">›</text>`;
      return out;
    }

    case "image":
    case "img": {
      // Artwork and avatars. Drawn as a labelled placeholder: the real bytes are
      // fetched at runtime and a placeholder that says which image it is standing
      // in for is more useful than a grey box.
      const tone = "#16304c";
      out += `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${tone}"/>`;
      out += `<text x="${x + width / 2}" y="${y + height / 2 + 5}" font-family="Helvetica, Arial, sans-serif" font-size="13" fill="#4a6b85" text-anchor="middle">${esc(w.id)}</text>`;
      return out;
    }

    case "obj": {
      if (height <= 2) {
        // A hairline. Drawn at full opacity with a minimum width so a 1px rule
        // is visible in a downscaled screenshot.
        out += `<rect x="${x}" y="${y}" width="${width}" height="1" fill="${w.bgColor ?? "#1a3050"}"/>`;
        return out;
      }
      out += `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${w.bgColor ?? "none"}"/>`;
      return out;
    }

    default: {
      // label, and anything unrecognised drawn as its text so it cannot vanish.
      if (w.text === null) return "";
      out += `<text x="${x}" y="${y + font.px * 0.75}" font-family="${family}" font-size="${font.px}" fill="${w.textColor ?? "#dce8f5"}">${esc(w.text)}</text>`;
      return out;
    }
  }
}

const STRIP_H = 30;

function render(widgets: Widget[], caption: string): string {
  const body = widgets.map(widgetSvg).join("\n");
  // The caption goes in a strip BELOW the panel, not on it. Drawn over the
  // panel it covered the title; drawn at the bottom-right it covered the
  // keyboard. A caption that sits on top of the thing it describes is worse
  // than no caption, and this layout has no safe corner.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${PANEL_H + STRIP_H}" viewBox="0 0 ${PANEL_W} ${PANEL_H + STRIP_H}">
  <rect width="${PANEL_W}" height="${PANEL_H}" fill="#06101e"/>
${body}
  <rect x="0" y="${PANEL_H}" width="${PANEL_W}" height="${STRIP_H}" fill="#0d1f35"/>
  <text x="12" y="${PANEL_H + 20}" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#6a8ba8">${esc(caption)}</text>
</svg>`;
}

const kb = parseKeyboardState(ROOT);

const NOTE =
  "geometry exact · typefaces approximated (Georgia/Helvetica stand in for Newsreader/Archivo) · QR not encoded · text wrapping indicative";

fs.mkdirSync(OUT_DIR, { recursive: true });

// Every screen, and for the setup screen both keyboard states — because the
// interesting bugs live in the transition, which is not in the YAML at all.
const jobs: Array<[string, Widget[], string]> = [];
for (const name of SCREENS) {
  const widgets = parseWidgets(screenPath(ROOT, name));
  if (widgets.size === 0) {
    console.log(`  SKIP  ${name} — no widgets parsed`);
    continue;
  }
  if (name === "setup_wifi" || name === "setup_bind") {
    jobs.push([`${name}-keyboard-closed`, closedState(widgets), `${name} · keyboard closed`]);
    jobs.push([`${name}-keyboard-open`, openState(widgets, kb), `${name} · keyboard open`]);
  } else {
    jobs.push([name, closedState(widgets), name]);
  }
}

for (const [name, widgets, caption] of jobs) {
  const svg = render(widgets, `${caption} — ${NOTE}`);
  const out = path.join(OUT_DIR, `${name}.png`);
  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`  wrote ${path.relative(ROOT, out)}  (${widgets.filter((w) => !w.hidden).length} visible)`);
}

console.log("  NOTE: geometry is exact; typefaces are not. Text wrapping is indicative.");
