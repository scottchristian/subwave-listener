// Throwaway: the update check's correctness lives entirely in isNewerVersion, so
// exercise it against the orderings that actually bite.
import { isNewerVersion } from "../lib/version.ts";

type Case = [candidate: string, current: string, expected: boolean, why: string];

const cases: Case[] = [
  // The reason this function exists: string sorting gets these backwards.
  ["0.0.10", "0.0.9", true, "10 > 9 numerically, but sorts before as a string"],
  ["0.0.9", "0.0.10", false, "reverse of the above"],
  ["0.0.100", "0.0.99", true, "three-digit patches"],
  ["0.1.0", "0.0.9", true, "minor bump"],
  ["1.0.0", "0.9.9", true, "major bump"],
  ["0.10.0", "0.9.0", true, "double-digit minor"],

  // Same version is never an update.
  ["0.0.1", "0.0.1", false, "identical"],
  ["v0.0.1", "0.0.1", false, "tag prefix is not a difference"],
  ["0.0.1", "v0.0.1", false, "prefix on the installed side"],

  // Downgrades are not updates.
  ["0.0.1", "0.1.0", false, "older candidate"],
  ["0.0.1", "1.0.0", false, "much older candidate"],

  // Prereleases sit below their own release, so a finished release does not get
  // nagged back to a beta.
  ["0.1.0-beta.1", "0.1.0", false, "beta is older than the release"],
  ["0.1.0", "0.1.0-beta.1", true, "release is newer than its own beta"],
  ["0.2.0-beta.1", "0.1.0", true, "prerelease of a newer minor is still newer"],
  ["0.1.0-beta.2", "0.1.0-beta.1", true, "later beta"],

  // Malformed tags must leave the operator alone rather than invent an update.
  ["nightly", "0.0.1", false, "unparseable candidate"],
  ["0.0.1", "nightly", false, "unparseable current"],
  ["", "0.0.1", false, "empty candidate"],
  ["v", "0.0.1", false, "prefix only"],

  // Leading/tolerated whitespace, as a human-typed tag might have.
  [" 0.0.2 ", "0.0.1", true, "padded candidate"],
  // Extra segments beyond the third are ignored, not fatal.
  ["0.0.2+build5", "0.0.1", true, "build metadata"],
];

let failed = 0;
for (const [candidate, current, expected, why] of cases) {
  const got = isNewerVersion(candidate, current);
  if (got !== expected) {
    failed++;
    console.log(`  FAIL  ${candidate} vs ${current} -> ${got}, wanted ${expected}  (${why})`);
  }
}
console.log(`  ${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
