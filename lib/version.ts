// The version of this software, in one place.
//
// LOAD-BEARING: APP_VERSION is read from package.json at build time, and it is the
// same string the footer shows, the update check compares against, and the release
// is tagged with. Do not hardcode a second copy anywhere. If these ever disagree,
// the app will either claim an update exists that does not or hide one that does —
// and the operator has no way to tell which, because the footer is the only place
// the version appears.
// The import attribute is what lets this run under plain Node as well as the
// bundler: Node's ESM loader refuses a JSON module without one, and the check
// script runs this file directly. TypeScript and Turbopack both accept it.
import pkg from "../package.json" with { type: "json" };

export const APP_VERSION: string = pkg.version;

/**
 * Where releases are published. The update check reads this repo's releases, so a
 * station that has moved the code elsewhere simply sees no update rather than
 * being told to pull from a repository that is not theirs.
 */
export const REPO = "scottchristian/subwave-listener";

export const REPO_URL = `https://github.com/${REPO}`;

/**
 * Is `candidate` newer than `current`?
 *
 * Compares numerically rather than alphabetically, because that is the whole
 * reason this function exists: "0.0.10" sorts *before* "0.0.9" as a string, so a
 * naive comparison silently stops telling the operator about updates at the tenth
 * release of anything. Any release that could plausibly ship here — a 0.x beta, a
 * prerelease like `0.1.0-beta.1`, a two-digit patch — has to sort correctly.
 *
 * Prereleases (anything after a `-`) sort *below* their own release, so
 * `0.1.0-beta.1` is not offered as newer than `0.1.0`. That matters when a beta is
 * the newest tag: an operator on the final release must not be nagged back to it.
 * Returns false for anything unparseable rather than guessing — a malformed tag
 * from a mis-tagged release should leave the operator alone, not show a bogus
 * update prompt that leads nowhere.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      pre: m[4] ?? null,
    };
  };

  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;

  for (const k of ["major", "minor", "patch"] as const) {
    if (a[k] !== b[k]) return a[k] > b[k];
  }

  // Same numbers: a prerelease is older than the finished release, and two
  // prereleases fall back to a string compare (good enough — they only differ by
  // beta/rc ordering within one release, which we do not currently publish).
  if (a.pre && !b.pre) return false;
  if (!a.pre && b.pre) return true;
  if (a.pre && b.pre) return a.pre > b.pre;
  return false;
}
