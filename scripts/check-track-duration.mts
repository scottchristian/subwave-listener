// Throwaway: resolveTrackDuration. The countdown's correctness depends on this
// returning a real measured length or null — never a guess.
import {
  resolveTrackDuration,
  isDurationDiscredited,
  DURATION_OVERSHOOT_GRACE_SEC,
} from "../lib/trackduration.ts";

type Case = [np: any, history: any, expected: number | null, why: string];

const H = [
  { subsonic_id: "a1", title: "Alpha", artist: "X", startedAt: "2026-10-02T08:00:00.000Z", endedAt: "2026-10-02T08:03:48.000Z" },
  { subsonic_id: "b2", title: "Beta", artist: "Y", startedAt: "2026-10-02T07:50:00.000Z", endedAt: "2026-10-02T07:50:05.000Z" },
  { subsonic_id: "c3", title: "Gamma", artist: "Z", startedAt: "not-a-date", endedAt: "2026-10-02T07:40:00.000Z" },
];

const cases: Case[] = [
  [{ duration: 200 }, H, 200, "direct duration wins"],
  [{ duration: "200" }, H, 200, "string duration coerced"],
  [{ duration: 0, subsonic_id: "a1" }, H, 228, "zero duration falls through to history"],
  [{ duration: null, subsonic_id: "a1" }, H, 228, "null duration resolved from history"],
  [{ subsonic_id: "a1" }, H, 228, "no duration key at all"],
  [{ subsonic_id: "nope" }, H, null, "unknown track"],
  [{ title: "Alpha", artist: "X" }, H, 228, "title+artist fallback without id"],
  [{ title: "alpha", artist: "x" }, H, 228, "matching is case-insensitive"],
  [{ title: "Alpha", artist: "WRONG" }, H, null, "artist mismatch does not match"],
  [{ subsonic_id: "b2" }, H, null, "5-second history row rejected as corrupt, not returned"],
  [{ subsonic_id: "c3" }, H, null, "unparseable dates rejected"],
  [{ subsonic_id: "a1" }, [], null, "empty history"],
  [{ subsonic_id: "a1" }, null, null, "null history"],
  [{ subsonic_id: "a1" }, "junk", null, "non-array history"],
  [{}, H, null, "track with no identity at all"],
  [null, H, null, "null track"],
];

let failed = 0;
for (const [np, history, expected, why] of cases) {
  const got = resolveTrackDuration(np, history);
  if (got !== expected) {
    failed++;
    console.log(`  FAIL  -> ${got}, wanted ${expected}  (${why})`);
  }
}
// The stuck-at-zero guard: only past the grace, never inside it.
const grace: Array<[raw: number, expected: boolean, why: string]> = [
  [10, false, "still playing"],
  [0, false, "exactly at the end — the promotion window"],
  [-1, false, "a second past — still the promotion window"],
  [-DURATION_OVERSHOOT_GRACE_SEC, false, "exactly at the grace boundary"],
  [-DURATION_OVERSHOOT_GRACE_SEC - 1, true, "past the grace — discredited"],
  [-300, true, "minutes past — discredited"],
];
for (const [raw, expected, why] of grace) {
  const got = isDurationDiscredited(raw);
  if (got !== expected) {
    failed++;
    console.log(`  FAIL  raw=${raw} -> ${got}, wanted ${expected}  (${why})`);
  }
}
const total = cases.length + grace.length;
console.log(`  ${total - failed}/${total} passed`);
if (failed) process.exit(1);
