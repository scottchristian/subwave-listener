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