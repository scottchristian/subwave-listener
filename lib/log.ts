"use client";
// Verbose browser-console diagnostics for the player. Admin toggles it in
// Admin → Diagnostics (Setting `verboseLogging`); /api/settings carries it
// and page.tsx syncs it here on load. Everything rides console with a
// [player] tag + timestamp so failures can be diagnosed from a screenshot.

let verbose = true;

export function setVerbose(on: boolean) {
  verbose = on;
}

const ts = () => new Date().toISOString().slice(11, 23);

export const plog = {
  info(...args: unknown[]) {
    if (verbose) console.log(`[player ${ts()}]`, ...args);
  },
  warn(...args: unknown[]) {
    if (verbose) console.warn(`[player ${ts()}]`, ...args);
  },
  error(...args: unknown[]) {
    // Errors always log — silence here hides outages.
    console.error(`[player ${ts()}]`, ...args);
  },
};
