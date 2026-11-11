/**
 * Who gets the Skip button.
 *
 * This is deliberately one module, read by both the player (to decide whether to
 * render the button) and the skip route (to decide whether to honour it). Those
 * two have to agree exactly: if the client shows a button the server refuses,
 * the user gets a dead control, and hiding is not the same as refusing. Keeping
 * the rule here means the policy cannot drift between the two call sites.
 *
 * Admins are not covered by this setting — an operator needs Skip regardless, so
 * both call sites check `isAdmin` separately and let it win.
 *
 *   hidden — no listener ever sees it
 *   solo   — only while they are the only listener (cutting for company is rude)
 *   always — everyone, any time; a listener cutting for company gets a confirm
 */
export type SkipVisibility = "hidden" | "solo" | "always";

/** Solo, which is what the station has always done. */
export const SKIP_VISIBILITY_DEFAULT: SkipVisibility = "solo";

/** The stored value is a free-form string, so anything unrecognised is solo. */
export function parseSkipVisibility(raw: unknown): SkipVisibility {
  return raw === "hidden" || raw === "always" ? raw : SKIP_VISIBILITY_DEFAULT;
}

/**
 * How wall-mounted screens are treated, independently of listeners.
 *
 * This is a SEPARATE setting from SkipVisibility on purpose. SkipVisibility
 * governs the listener experience, and changing it must not silently change what
 * a public display in a café can do — those are two different decisions by two
 * different people, and folding them together makes one of them unmakeable.
 *
 *   follow    — behave exactly as a listener would (the default)
 *   listener  — always treated as a listener, even when the station has Skip off
 *               for listeners
 *   hidden    — never offer it on a screen
 *
 * Note what `follow` means under the default `solo` mode: a screen on a wall is
 * almost never offered Skip, because `listeners <= 1` fails the moment one real
 * person is listening. That is the setting working, not a bug. In an empty room
 * `listeners` is 0 and the screen does get Skip — identical to what a real sole
 * listener sees after they stop, so this is genuinely 1:1.
 */
export type SkipVisibilityScreens = "follow" | "listener" | "hidden";

export const SKIP_VISIBILITY_SCREENS_DEFAULT: SkipVisibilityScreens = "follow";

export function parseSkipVisibilityScreens(raw: unknown): SkipVisibilityScreens {
  return raw === "hidden" || raw === "listener" ? raw : SKIP_VISIBILITY_SCREENS_DEFAULT;
}

/**
 * Is Skip offered on a screen right now?
 *
 * Same fail-closed shape as the listener path: an unreadable setting parses as
 * `follow`, which lands on whatever the listener rule says, and an unknown
 * headcount hides the button rather than offering one the server will refuse.
 */
export function canSkipAsScreen(
  screens: SkipVisibilityScreens,
  listenerMode: SkipVisibility,
  listeners: number | null | undefined,
  deviceEnabled: boolean,
): boolean {
  // A device-level opt-out wins over everything, so one screen can hide Skip
  // without changing what every other screen can do.
  if (!deviceEnabled) return false;
  if (screens === "hidden") return false;
  if (screens === "listener") return true;
  return canSkipAsListener(listenerMode, listeners);
}

/** May a non-admin listener be offered Skip right now? */
export function canSkipAsListener(
  mode: SkipVisibility,
  listeners: number | null | undefined
): boolean {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  // "solo" fails closed on an unknown headcount — better no button than one
  // that the server will reject a second later.
  return typeof listeners === "number" && listeners <= 1;
}

/** Labels for the admin control, kept beside the logic they describe. */
export const SKIP_VISIBILITY_OPTIONS: {
  value: SkipVisibility;
  label: string;
  blurb: string;
}[] = [
  {
    value: "hidden",
    label: "Always hide",
    blurb: "No listener sees the Skip button. Admins still do.",
  },
  {
    value: "solo",
    label: "Show when solo",
    blurb: "Only while they are the one listening. Cutting a track other people are hearing is rude, so it stays out of the way.",
  },
  {
    value: "always",
    label: "Always show",
    blurb: "Offered to everyone at any time. A listener who cuts with others listening has to confirm first.",
  },
];
/** Labels for the screen control, kept beside the logic they describe. */
export const SKIP_VISIBILITY_SCREENS_OPTIONS: {
  value: SkipVisibilityScreens;
  label: string;
  blurb: string;
}[] = [
  {
    value: "follow",
    label: "Like a listener",
    blurb:
      "A screen is offered Skip on exactly the terms a listener would be. With ‘Show when solo’ above, that means a screen in a room where somebody is listening does not get the button — which is usually what you want, and occasionally not.",
  },
  {
    value: "listener",
    label: "Always like a listener",
    blurb:
      "A screen counts as a listener for this rule even when Skip is off for listeners. Use it when you want one screen to be able to skip in a room nobody is using their phone in.",
  },
  {
    value: "hidden",
    label: "Never on a screen",
    blurb:
      "No wall screen ever shows the Skip button. Individual screens can also hide it themselves from their own settings screen, without changing this for every screen.",
  },
];
