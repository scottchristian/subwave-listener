// Which branding file to serve, and from where.
//
// WHY THIS EXISTS. Operator branding and the software's placeholder artwork used
// to be the same files. The repository shipped `public/official_logo.png`,
// `public/bg.jpg`, `public/favicon.ico` and `public/icons/`, and an upload from
// Admin → Station → Branding overwrote those exact paths. Two things then went
// wrong, and neither was visible from the code:
//
//   1. Every deploy re-uploaded the repository's placeholders over the station's
//      own artwork, because the deploy syncs the working tree. A dry run before
//      one deploy showed public/official_logo.png about to be replaced, 138KB on
//      the server against 1.2MB in the repository.
//   2. Any branding uploaded through the dashboard was destroyed by the next
//      deploy, silently.
//
// The two concepts are now in different places and can never collide:
//
//   public/defaults/  shipped by the repository. Never written by the app.
//   data/brand/       written only by the app, from an operator upload. Excluded
//                     from BOTH .gitignore and the deploy rsync, so it survives
//                     both, and it holds the only copy of a real station's face.
//
// WHY THE URL NEVER CHANGES. The logo is referenced from client components and
// the background from the stylesheet, so both are baked at build time; changing
// a path would mean a rebuild on every change. Instead the path is fixed forever
// and this resolver decides which bytes it maps to, per request. Uploads apply
// instantly, which is what the old design got right and worth keeping, and
// removing an operator's branding reverts to the defaults instantly too.
//
// No database read and no environment variable, deliberately. The presence of the
// file IS the state, so there is no way for a stored path to point at something
// that was never uploaded or has since been deleted.

import { promises as fs } from "node:fs";
import path from "node:path";

/** Shipped placeholders. Replaced on deploy, never written by the app. */
export const DEFAULTS_DIR = path.join(process.cwd(), "public", "defaults");

/** A real station's artwork. Written by the app, never synced, never committed. */
export const BRAND_DIR = path.join(process.cwd(), "data", "brand");

/**
 * The assets an operator can replace, and the placeholder each falls back to.
 *
 * A key is the stable public URL segment; the value is the shipped default's
 * name inside public/defaults. Both are fixed strings, so a request path is
 * validated against this list rather than joined onto a directory — a route
 * parameter must never reach the filesystem unchecked, even a read.
 */
export const BRAND_ASSETS: Record<string, string> = {
  "logo.png": "official_logo.png",
  "bg.jpg": "bg.jpg",
  "favicon.ico": "favicon.ico",
  "icons/apple-touch-icon.png": "icons/apple-touch-icon.png",
  "icons/favicon-32x32.png": "icons/favicon-32x32.png",
  "icons/icon-192.png": "icons/icon-192.png",
  "icons/icon-192-maskable.png": "icons/icon-192-maskable.png",
  "icons/icon-512.png": "icons/icon-512.png",
  "icons/icon-512-maskable.png": "icons/icon-512-maskable.png",
};

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/** Is this a known asset? Anything else is a 404, not a filesystem probe. */
export function isBrandAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BRAND_ASSETS, name);
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream";
}

/**
 * Operator's copy if there is one, otherwise the shipped placeholder.
 *
 * Returns null only when the placeholder is missing too, which means a broken
 * checkout rather than a branding choice.
 */
export async function resolveBrandAsset(
  name: string,
): Promise<{ body: Buffer; source: "operator" | "default" } | null> {
  if (!isBrandAsset(name)) return null;

  const operatorCopy = path.join(BRAND_DIR, name);
  try {
    const body = await fs.readFile(operatorCopy);
    if (body.length) return { body, source: "operator" };
  } catch {
    // No operator branding for this asset, which is the normal case.
  }

  try {
    const body = await fs.readFile(path.join(DEFAULTS_DIR, BRAND_ASSETS[name]));
    if (body.length) return { body, source: "default" };
  } catch {
    // Fall through.
  }
  return null;
}

/** Does this station have its own artwork, rather than the placeholders? */
export async function hasOperatorBranding(): Promise<boolean> {
  try {
    await fs.access(path.join(BRAND_DIR, "logo.png"));
    return true;
  } catch {
    return false;
  }
}
