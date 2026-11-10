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
  /**
   * The widget's LVGL alignment, or null when it does not say.
   *
   * It matters because x and y MEAN DIFFERENT THINGS under a different anchor.
   * With TOP_LEFT they are the top-left corner, which is what a layout check can
   * reason about. Under BOTTOM_LEFT, y is measured UP from the bottom edge — so
   * `shows_expanded`'s `y: -88px` does not put it 88px above the top of the
   * screen, it puts it 88px BELOW the bottom, which is how it is stowed off-screen
   * before a show is expanded.
   *
   * Reading that as a top-left coordinate put a 1152x200 tray across the station
   * header and reported it as a collision that does not exist.
   */
  align: string | null;
  /**
   * True when this widget sits inside another widget's `widgets:` list.
   *
   * It matters because a child is positioned RELATIVE to its parent, so a child
   * and its parent routinely share coordinates. An overlap check that treated
   * those as a collision would fail on every button with a label in it, which
   * is every button — and a check that cries wolf gets ignored.
   *
   * Detected by indentation, since ESPHome's new LVGL schema makes the parent
   * the `widgets:` list an entry appears in, and top-level entries are the only
   * ones at column zero.
   */
  nested: boolean;
  /** Widgets whose width is a percentage resolve against this. */
  parentWidth: number;
  parentId?: string | null;
}

/**
 * Every screen body, in the order the carousel visits them.
 *
 * ALL FOUR, not just the setup screen. The setup screen was the one anybody had
 * looked at, so it was the one that was checked — and the other three had never
 * been drawn or asserted, which is the same blind spot the setup screen had and
 * the reason four faults survived in it.
 */
export const SCREENS = ["setup_wifi", "setup_bind", "now", "shows", "settings"] as const;
export type ScreenName = (typeof SCREENS)[number];

export function screenPath(root: string, name: string): string {
  return path.join(root, "device", "firmware", "common", "screens", `${name}.yaml`);
}

export function setupScreenPath(root: string): string {
  return screenPath(root, "setup");
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

function applyKeyValue(cur: Widget, key: string, rawVal: string, out: Map<string, Widget>) {
  const v = rawVal.trim();
  switch (key) {
    case "id":
      cur.id = v;
      out.set(v, cur);
      break;
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
    case "size":
      cur.w = numberOr(v);
      cur.h = numberOr(v);
      break;
    case "text":
    case "placeholder_text":
      if (cur.text === null || key === "text") {
        cur.text = v.replace(/^["']|["']$/g, "");
      }
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
    case "align":
      cur.align = v;
      break;
    default:
      break;
  }
}

export function parseWidgets(file: string): Map<string, Widget> {
  const out = new Map<string, Widget>();
  if (!fs.existsSync(file)) return out;

  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^- \w+:/.test(l));
  if (start === -1) return out;

  let cur: Widget | null = null;
  const stack: Array<{ indent: number; widget: Widget }> = [];

  for (const raw of lines.slice(start)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;

    // A top-level entry starts at column zero; anything indented is a child of
    // whichever `widgets:` list encloses it.
    const head = /^(\s*)- (\w+):\s*(.*)$/.exec(raw);
    if (head) {
      const indent = head[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack.length > 0 ? stack[stack.length - 1].widget : null;
      cur = {
        nested: indent > 0,
        kind: head[2],
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
        align: null,
        parentWidth: parent?.w ?? PANEL_W,
        parentId: parent?.id || null,
      };
      stack.push({ indent, widget: cur });

      const inline = head[3].trim();
      if (inline.startsWith("{") && inline.endsWith("}")) {
        const inner = inline.slice(1, -1);
        for (const pair of inner.split(/,(?=\s*[a-z_]+:)/)) {
          const kv = /^\s*([a-z_]+):\s*(.*)$/.exec(pair);
          if (kv) applyKeyValue(cur, kv[1], kv[2], out);
        }
      }
      continue;
    }
    if (!cur) continue;

    const kv = /^\s+([a-z_]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    applyKeyValue(cur, kv[1], kv[2], out);
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

export function parseKeyboardState(root: string): KeyboardState {
  const file = scriptsPath(root);
  const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

  const moves = [...src.matchAll(/lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\)/g)].map((m) =>
    Number(m[1]),
  );

  const deltaMatch = /int32_t delta\s*=\s*opening\s*\?\s*(\d+)\s*-\s*(\d+)/.exec(src);
  const baseMatch = /lv_obj_set_y\(id\(wifi_password\),\s*(\d+)\s*\+\s*delta\)/.exec(src);

  const toggle = src.slice(src.indexOf("- id: wifi_keyboard_toggle"));
  const rowMatch = /lv_obj_t \*hidden_while_typing\[\]\s*=\s*\{([^}]*)\}/.exec(toggle);
  const keysMatch = /lv_obj_t \*shown_while_typing\[\]\s*=\s*\{([^}]*)\}/.exec(toggle);

  const ids = (m: RegExpExecArray | null): string[] =>
    m ? [...m[1].matchAll(/id\((\w+)\)/g)].map((x) => x[1]) : [];

  const shown = ids(keysMatch);
  for (const kbId of ["wifi_keyboard", "wifi_kb", "bind_kb"]) {
    if (!shown.includes(kbId)) shown.push(kbId);
  }

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
