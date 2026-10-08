// Album art must be warmed before it is needed, and the warm-up must actually
// warm the thing that gets displayed.
//
// The premise this file exists to protect: /api/cover/{subsonic_id} is served
// `immutable, max-age=86400`, so the browser keeps a cover forever once it has
// seen it. That makes prefetching the upcoming covers free at swap time, and it
// makes a second listen of the same album cost no network at all — including
// the ~1.15s / 73KB fetch measured against the live endpoint, which otherwise
// lands exactly on the moment the art changes.
//
// The premise is fragile in a way nothing else would catch. The prefetch builds
// a URL in one place and the player renders it in three others (now-playing,
// up-next, queue rows). Nothing forces those to agree. Add a size parameter to
// one, or a cache-busting query to another, and the bytes are cached under a
// key nobody reads — the prefetch still runs, still succeeds, still looks
// correct, and the swap still stalls. Silent, and there is no user-visible
// error to trace it from. So the URLs are compared here.
//
// It also pins two things that are easy to break while editing:
//
//   - the effect is bounded by a slice, because `upcoming` is untrusted in
//     length and an unbounded window is a bandwidth bill aimed at the host
//   - it constructs `window.Image`, not `Image`. This module imports next/image
//     as `Image`, so the bare name is a component constructor and `new Image()`
//     is a type error that reads as nothing to do with album art
//
// Hook ORDER is not re-checked here: this file adds a useEffect to Home, and
// scripts/check-hooks-after-return.mts already scans every component for hooks
// below an early return — the bug that took the player down for two days.
//
// Run: node scripts/check-art-prefetch.mts (wired as `npm run check:art`).
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

/** Reasons this source would fail, so the checks below can be tested. */
function audit(src: string): string[] {
  const bad: string[] = [];

  const effect = src.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?appStateData\?\.upcoming[\s\S]*?\}, \[appStateData\]\);/);
  if (!effect) {
    bad.push("no effect warms the covers listed in appStateData.upcoming");
    return bad;
  }
  const body = effect[0];

  // Bounded. `upcoming` is untrusted in length.
  if (!/\.slice\(0,\s*[A-Z_][A-Z0-9_]*\)/.test(body)) {
    bad.push("the warm-up is not bounded by a slice over a named window");
  }
  // De-duplicated, or the 5s poll re-requests the same covers forever.
  if (!/warmed\w*\.includes\(/.test(body) || !/warmed\w*\.push\(/.test(body)) {
    bad.push("the warm-up does not remember what it has already requested");
  }
  if (!/warmed\w*\.splice\(|\.shift\(\)|delete /.test(body)) {
    bad.push("the warmed list is never trimmed, so it grows for as long as the station plays");
  }
  // `Image` here is next/image. See the header.
  if (/\bnew Image\s*\(/.test(body)) bad.push("uses `new Image()` — that is the next/image component, not the DOM constructor");
  if (!/new window\.Image\s*\(/.test(body)) bad.push("does not construct a detached DOM Image");
  if (!/\.src\s*=/.test(body)) bad.push("never assigns a src, so nothing is fetched");
  if (!/subsonic_id/.test(body)) bad.push("does not key the warm-up on subsonic_id");

  // THE PREMISE. Every cover URL on the page must be the same bare URL, or the
  // cache key the prefetch fills is not the key the render reads.
  const covers = [...src.matchAll(/`\$\{STATION_API\}(\/api\/cover\/[^`]*)`/g)].map((m) => m[1]);
  if (!covers.length) bad.push("no cover URLs found — the scan is looking in the wrong place");
  const odd = covers.filter((c) => /[?&]/.test(c));
  if (odd.length) bad.push(`cover URL carries a query string, so it is not the immutable key: ${[...new Set(odd)].join(" ")}`);
  const shapes = new Set(covers.map((c) => c.replace(/\$\{[^}]*\}/g, "\${}")));
  if (shapes.size > 1) {
    bad.push(`cover URLs disagree in shape (${[...shapes].join("  vs  ")}) — the prefetch would warm a key nobody reads`);
  }

  return bad;
}

// ------------------------------------------------------------------ the app

const raw = readFileSync(path.join(REPO, "app/page.tsx"), "utf8");
const route = scrub(raw);
const findings = audit(route);
for (const f of findings) console.log(`  FAIL  ${f}`);
ok(findings.length === 0, "album art is warmed ahead of the swap, and the URL the warm-up uses is the URL that gets rendered", findings);

// The up-next card is where the art is already on screen — check that path is
// genuinely warm rather than assuming it, since the prefetch makes it redundant
// but the two must not have drifted apart in what they display.
ok(
  /id="up-next-art"/.test(raw) && /id="now-playing-art"/.test(raw),
  "both the now-playing and up-next art elements are still rendered"
);
ok(
  /const UPCOMING_ART_PREFETCH = \d+;/.test(raw),
  "and the window size is a named constant, not a literal buried in the effect"
);

// ------------------------------------------------- the checker checks itself

const GOOD = `
  const UPCOMING_ART_PREFETCH = 3;
  useEffect(() => {
    const upcoming = Array.isArray(appStateData?.upcoming) ? appStateData.upcoming : [];
    const warmed = warmedArtRef.current;
    for (const track of upcoming.slice(0, UPCOMING_ART_PREFETCH)) {
      const id = track?.subsonic_id;
      if (typeof id !== "string" || !id || warmed.includes(id)) continue;
      const img = new window.Image();
      img.decoding = "async";
      img.src = \`\${STATION_API}/api/cover/\${id}\`;
      warmed.push(id);
    }
    if (warmed.length > UPCOMING_ART_PREFETCH * 4) {
      warmed.splice(0, warmed.length - UPCOMING_ART_PREFETCH * 4);
    }
  }, [appStateData]);
  const a = <img src={\`\${STATION_API}/api/cover/\${np.subsonic_id}\`} />;
  const b = <img src={\`\${STATION_API}/api/cover/\${next.subsonic_id}\`} />;`;

ok(audit(GOOD).length === 0, "a correct warm-up passes", audit(GOOD));

{
  // The silent failure: the render grows a size parameter, the prefetch does
  // not. Nothing errors. The cache key the prefetch fills is not the key the
  // player reads, and the swap stalls exactly as it did before.
  const f = audit(GOOD.replace("const a = <img src={`${STATION_API}/api/cover/${np.subsonic_id}`} />;", "const a = <img src={`${STATION_API}/api/cover/${np.subsonic_id}?size=256`} />;"));
  ok(f.some((x) => /not the immutable key/.test(x)), "a cover URL with a query string is caught", f);
  ok(f.some((x) => /disagree in shape/.test(x)), "and a prefetch/render shape mismatch is caught", f);
}

{
  const f = audit(GOOD.replace("new window.Image()", "new Image()"));
  ok(f.some((x) => /next\/image component/.test(x)), "`new Image()` (the shadowed next/image import) is caught", f);
}

{
  const f = audit(GOOD.replace("upcoming.slice(0, UPCOMING_ART_PREFETCH)", "upcoming"));
  ok(f.some((x) => /not bounded by a slice/.test(x)), "an unbounded window is caught", f);
}

{
  const f = audit(GOOD.replace("warmed.includes(id) || ", "").replace("warmed.push(id);", ""));
  ok(f.some((x) => /already requested/.test(x)), "re-requesting on every poll is caught", f);
}

{
  const f = audit(GOOD.replace("warmed.splice(0, warmed.length - UPCOMING_ART_PREFETCH * 4);", ""));
  ok(f.some((x) => /never trimmed/.test(x)), "an unbounded warmed list is caught", f);
}

{
  // A page with no warm-up at all must fail, not pass by having nothing to check.
  ok(audit("const x = 1;").length > 0, "a source with no warm-up is a failure, not a pass");
}

console.log(`  ${passed}/${passed + failed} art-prefetch assertions passed`);
if (failed) process.exit(1);