// The album art must not snap over ~bufferSeconds early.
//
// The bug this exists for: the promotion delay was gated on
//
//   np?.title && cur && cur.title === np.title && cur.startedAt
//
// — an exact string match. A curly apostrophe, a "feat.", a live-set title, or
// any re-render difference left `serverStart` at NaN, which made `audibleAt`
// "now" and promoted the art (and the title, and the lineup) about
// `bufferSeconds` (22 by default) too early. Intermittent and track-dependent,
// which is why it read as "roughly 10 seconds, then changes a few seconds early"
// rather than as a clean off-by-22.
//
// The fix matches on the stable identity (subsonic_id) first, falls back to
// now-playing's own start time (unix seconds) when state and now-playing disagree,
// and logs a warning when neither is available instead of snapping silently.
//
// Run: node scripts/check-art-hold.mts (wired as `npm run check:art-hold`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrub } from "./lib/tsx-scan.mts";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
  }
}

const raw = readFileSync(path.join(REPO, "app/page.tsx"), "utf8");
const code = scrub(raw);

// The promote block, isolated.
const promote = raw.match(/let wait = 0;[\s\S]*?wait = audibleAt - Date\.now\(\);/);
ok(promote !== null, "the promote block is locatable");
const p = promote?.[0] ?? "";

{
  ok(/subsonic_id && cur\?\.subsonic_id/.test(p), "the track match uses subsonic_id when both sides carry it");
  ok(/np\.subsonic_id === cur\.subsonic_id/.test(p), "comparing the stable identity, not the title");
  // The fallback that keeps a mismatch from snapping to "now".
  ok(/np\?\.timestamp/.test(p), "and falls back to now-playing's own start time");
  ok(/\* 1000/.test(p), "converting the unix-seconds timestamp to milliseconds");
  ok(/plog\.warn\("promote: no usable start time, committing immediately"/.test(p), "and logs when neither source is usable, so the snap is visible in the wild");
  // The exact-title match alone is the bug; the new shape must not regress to it.
  const titleOnly = /cur && cur\.title === np\.title && cur\.startedAt/.test(p);
  ok(!titleOnly, "and does not gate on an exact title match alone");
}

// ------------------------------------------------- the checker checks itself

const GOOD = `
  let serverStart = NaN;
  const sameTrack = np?.subsonic_id && cur?.subsonic_id
    ? np.subsonic_id === cur.subsonic_id
    : Boolean(np?.title && cur?.title && cur.title === np.title);
  if (sameTrack && cur?.startedAt) {
    const t = Date.parse(cur.startedAt);
    if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
  }
  if (!Number.isFinite(serverStart) && np?.timestamp) {
    const t = Number(np.timestamp) * 1000;
    if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
  }
  if (!Number.isFinite(serverStart)) {
    plog.warn("promote: no usable start time, committing immediately", {});
  }
  const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : Date.now();
  wait = audibleAt - Date.now();`;

ok(audit(GOOD).length === 0, "a correct promote block passes", audit(GOOD));
function audit(s: string): string[] {
  const bad: string[] = [];
  if (!/subsonic_id && cur\?\.subsonic_id/.test(s)) bad.push("no subsonic_id match");
  if (!/np\.subsonic_id === cur\.subsonic_id/.test(s)) bad.push("no identity comparison");
  if (!/np\?\.timestamp/.test(s)) bad.push("no timestamp fallback");
  if (!/\* 1000/.test(s)) bad.push("no ms conversion");
  if (!/plog\.warn\("promote: no usable start time/.test(s)) bad.push("no warning");
  if (/cur && cur\.title === np\.title && cur\.startedAt/.test(s)) bad.push("exact-title-only gating returned");
  return bad;
}

{
  // The bug as it shipped: exact title match, no fallback, no warning.
  const f = audit(`
    let serverStart = NaN;
    if (np?.title && cur && cur.title === np.title && cur.startedAt) {
      const t = Date.parse(cur.startedAt);
      if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
    }
    const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : Date.now();
    wait = audibleAt - Date.now();`);
  ok(f.some((x) => /exact-title-only/.test(x)), "the shipped bug is caught", f);
  ok(f.some((x) => /no timestamp fallback/.test(x)), "including the missing fallback", f);
  ok(f.some((x) => /no warning/.test(x)), "and the silent snap", f);
}

{
  // A source with no promote block at all must fail, not pass by having nothing to check.
  ok(audit("const x = 1;").length > 0, "a source with no promote logic is a failure, not a pass");
}

console.log(`  ${passed}/${passed + failed} art-hold assertions passed`);
if (failed) process.exit(1);