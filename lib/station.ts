// Station identity + backend wiring for this web player.
// EVERYTHING an operator renames lives here or in .env — never hardcoded in
// pages. Values come from environment (NEXT_PUBLIC_* so client components can
// read them); the fallbacks are neutral placeholders, not a real station.
//
// LOAD-BEARING: each key MUST be read as `process.env.NEXT_PUBLIC_X` written
// out literally. Next inlines those at build time by static analysis —
// `process.env[key]` with a variable key does NOT get replaced, so client
// bundles silently fall back to defaults (that's how a whole deploy once
// shipped reading "Community Radio"). Never "simplify" this with a helper.
const clean = (v: string | undefined, fallback: string): string =>
  v && v.trim() ? v.trim() : fallback;

export const STATION = {
  /** Display name: header, titles, PWA, push, media-session. */
  name: clean(process.env.NEXT_PUBLIC_STATION_NAME, "Community Radio"),
  /** Short line under the logo. */
  tagline: clean(process.env.NEXT_PUBLIC_STATION_TAGLINE, "Broadcasting beyond boundaries."),
  /** One-liner for metadata + manifest. */
  description: clean(
    process.env.NEXT_PUBLIC_STATION_DESCRIPTION,
    "A private internet radio station with an AI DJ."
  ),
  /** Long about paragraph on the sign-in card. */
  about: clean(
    process.env.NEXT_PUBLIC_STATION_ABOUT,
    "A private internet radio station. Access is by invitation only — please sign in to listen to the live stream."
  ),
  /** Logo path in public/ (replace the file to rebrand). */
  logo: clean(process.env.NEXT_PUBLIC_STATION_LOGO, "/official_logo.png"),
  /**
   * Public Subwave backend base (no /api suffix needed — routes normalize it).
   * The browser calls this directly for now-playing/covers, so it must be the
   * PUBLIC address, not LAN.
   */
  backendUrl: clean(process.env.NEXT_PUBLIC_BACKEND_URL, ""),
  /** Fallback donate URL until Admin → Support Button saves one. */
  donateUrl: clean(process.env.NEXT_PUBLIC_DONATE_URL, ""),
} as const;
