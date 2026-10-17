// The setup screen's geometry, parsed out of the YAML.
//
// WHY THIS IS ITS OWN FILE. Two consumers need the same numbers and must not be
// able to disagree: the gate that asserts the layout is sound, and the renderer
// that draws it so a human can look at it. A gate and a preview that each parsed
// the file their own way would eventually check one thing and draw another,
// which is worse than having neither.
//
// WHY A LINE SCAN AND NOT A YAML PARSE. The firmware files use ESPHome tags
// (`!include`), which a stock loader rejects outright, and the thing worth
// extracting is the geometry AS WRITTEN — a parse-and-reemit would normalise
// exactly the values under suspicion, and a unit suffix spelled `px` on one line
// and absent on the next is precisely the kind of drift that should be visible
// rather than smoothed over.

import fs from "node:fs";
import path from "node:path";

export const PANEL_W = 1280;
export const PANEL_H = 800;

export interface Widget {
  kind: string;
  id: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  text: string | null;
  /** The `font_*` id a label renders with, e.g. `font_title`. */
  textFont: string | null;
  textColor: string | null;
  bgColor: string | null;
  radius: number | null;
  hidden: boolean;
  /** Widgets whose width is a percentage resolve against this. */
  parentWidth: number;
}

export function setupScreenPath(root: string): string {
  return path.join(root, "device", "firmware", "common", "screens", "setup.yaml");
}

export function scriptsPath(root: string): string {
  return path.join(root, "device", "firmware", "common", "screens", "scripts.yaml");
}

/** `#rrggbb` from an ESPHome `0xAARRGGBB` literal. Alpha is dropped. */
export function hex(value: string | null): string | null {
  if (!value) return null;
  const m = /^0x([0-9a-fA-F]{6,8})$/.exec(value.trim());
  if (!m) return null;
  const hex6 = m[1].slice(-6);
  return `#${hex6.toLowerCase()}`;
}

function numberOr(raw: string): number | null {
  const m = /(-?[\d.]+)\s*(px|%)?\s*$/.exec(raw.trim());
  if (!m) return null;
  return Math.round(Number(m[1]));
}

export function parseWidgets(file: string): Map<string, Widget> {
  const out = new Map<string, Widget>();
  if (!fs.existsSync(file)) return out;

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^- \w+:/.test(l));
  if (start === -1) return out;

  let cur: Widget | null = null;
  for (const raw of lines.slice(start)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    const head = /^- (\w+):/.exec(raw);
    if (head) {
      cur = {
        kind: head[1],
        id: "",
        x: null,
        y: null,
        w: null,
        h: null,
        text: null,
        textFont: null,
        textColor: null,
        bgColor: null,
        radius: null,
        hidden: false,
        parentWidth: PANEL_W,
      };
      continue;
    }
    if (!cur) continue;

    const id = /^\s+id:\s*(\S+)/.exec(raw);
    if (id) {
      cur.id = id[1];
      out.set(id[1], cur);
      continue;
    }

    // A quoted scalar may contain ": ", so only split on the first colon.
    const kv = /^\s+([a-z_]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    const v = value.trim();

    switch (key) {
      case "x":
        cur.x = numberOr(v);
        break;
      case "y":
        cur.y = numberOr(v);
        break;
      case "width":
        cur.w = numberOr(v);
        break;
      case "height":
        cur.h = numberOr(v);
        break;
      case "text":
        cur.text = v.replace(/^["']|["']$/g, "");
        break;
      case "text_font":
        cur.textFont = v;
        break;
      case "text_color":
        cur.textColor = hex(v);
        break;
      case "bg_color":
        cur.bgColor = hex(v);
        break;
      case "radius":
        cur.radius = numberOr(v);
        break;
      case "hidden":
        cur.hidden = v === "true";
        break;
      default:
        break;
    }
  }
  return out;
}

/** The two positions the password field occupies, and what the keyboard covers. */
export interface KeyboardState {
  raisedY: number | null;
  restingY: number | null;
  /** Hidden while the keyboard is up, because the field moves onto them. */
  hiddenWhileTyping: string[];
  /** Shown only while the keyboard is up. */
  shownWhileTyping: string[];
}

/**
 * Read the keyboard toggle out of scripts.yaml.
 *
 * The positions are written there as `lv_obj_set_y(id(wifi_password), N)` calls
 * — the first raises, the second restores — rather than parsed out of a table,
 * because that is genuinely how they are written. The arrays of ids the toggle
 * hides and shows are read as text, which is a weaker guarantee: it cannot tell a
 * hide from a show by reading a name. That is why the GATE checks the toggle's
 * opening branch directly, and this function is for drawing, not for deciding.
 */
export function parseKeyboardState(root: string): KeyboardState {
  const file = scriptsPath(root);
  const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  const moves = [...src.matchAll(/lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\)/g)].map((m) =>
    Number(m[1]),
  );

  // Two forms of the same thing, because the toggle changed shape once. The
  // first version wrote two literal `lv_obj_set_y` calls — raise, then restore.
  // The current one computes a single delta and applies it, so there is one
  // resting value and one raised value. Both are read, because the preview
  // should show whichever the file actually contains rather than assume.
  const deltaMatch = /int32_t delta\s*=\s*opening\s*\?\s*(\d+)\s*-\s*(\d+)/.exec(src);
  const baseMatch = /lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\s*\+\s*delta\)/.exec(src);

  const toggle = src.slice(src.indexOf("- id: wifi_keyboard_toggle"));
  // The arrays are named for what they DO, not for their shape, so this reader
  // and the toggle agree on one thing. When they were called `row[]` and `keys[]`
  // the reader silently stopped finding the first one after a rename — and a
  // preview that cannot see which widgets are hidden draws a screen that does
  // not exist, which is worse than drawing nothing.
  const rowMatch = /lv_obj_t \*hidden_while_typing\[\]\s*=\s*\{([^}]*)\}/.exec(toggle);
  const keysMatch = /lv_obj_t \*shown_while_typing\[\]\s*=\s*\{([^}]*)\}/.exec(toggle);

  const ids = (m: RegExpExecArray | null): string[] =>
    m ? [...m[1].matchAll(/id\((\w+)\)/g)].map((x) => x[1]) : [];

  // The keyboard widget is NOT in the keys array — the toggle clears its HIDDEN
  // flag directly, because it needs the pointer for the has-flag test that
  // decides which way the toggle is going. Forgetting that here means the
  // keyboard silently never appears in the open-state preview, which is the one
  // thing the preview exists to show.
  const shown = ids(keysMatch);
  if (!shown.includes("wifi_keyboard")) shown.push("wifi_keyboard");

  let restingY: number | null = null;
  let raisedY: number | null = null;
  if (deltaMatch && baseMatch) {
    raisedY = Number(deltaMatch[1]);
    restingY = Number(baseMatch[1]);
  } else if (moves.length >= 2) {
    raisedY = moves[0];
    restingY = moves[1];
  } else if (moves.length === 1) {
    raisedY = moves[0];
  }

  return {
    raisedY,
    restingY,
    hiddenWhileTyping: ids(rowMatch),
    shownWhileTyping: shown,
  };
}

/** Geometry with the keyboard closed: exactly what the YAML declares. */
export function closedState(widgets: Map<string, Widget>): Widget[] {
  return [...widgets.values()];
}

/**
 * Geometry with the keyboard open.
 *
 * Applies the three things the toggle does: the field moves up, the keyboard
 * furniture appears, and the controls the field lands on disappear. Anything not
 * applied here would be a widget the renderer draws that the real screen does not
 * — which is the whole reason this is worth building.
 */
export function openState(widgets: Map<string, Widget>, kb: KeyboardState): Widget[] {
  // Nothing is repositioned. The keyboard is placed UNDER the password field in
  // the layout rather than over the picker, so opening it changes only which
  // widgets are visible — see the note in wifi_keyboard_toggle for why the
  // version that moved the field was abandoned.
  const out: Widget[] = [];
  for (const w of widgets.values()) {
    const next = { ...w };

    if (w.id === "wifi_password" && kb.raisedY !== null) next.y = kb.raisedY;

    if (kb.hiddenWhileTyping.includes(w.id)) next.hidden = true;
    if (kb.shownWhileTyping.includes(w.id)) next.hidden = false;

    out.push(next);
  }
  return out;
}
