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

/**
 * The same class of risk, one layer down: public/sw.js.
 *
 * That worker existed for push only, and its header said why it cached nothing
 * — "the player polls live state and must never serve stale chunks". Art is now
 * the single exception. So the exception has to be provably narrow, because the
 * cost of widening it by accident is serving a stale application shell that no
 * amount of debugging will explain.
 *
 * It also has to not cache a failure. The route answers 502 when the upstream is
 * unreachable, and this worker is cache-first: it cannot see an opaque response's
 * status, so a 502 stored here would be permanent, invisible damage to that
 * track's artwork, recoverable only by clearing site data.
 */
function auditWorker(src: string): string[] {
  const bad: string[] = [];

  if (!/addEventListener\(\s*["']fetch["']/.test(src)) bad.push("no fetch handler, so nothing is ever cached");
  if (!/addEventListener\(\s*["']push["']/.test(src)) bad.push("the push handler is gone — notifications would break");

  // The guard has to exclude non-GET and non-cover before respondWith, and it
  // has to be the ONLY thing respondWith is reached through.
  if (!/req\.method\s*!==\s*["']GET["']/.test(src)) bad.push("the fetch handler does not exclude non-GET requests");
  const match = src.match(/pathname\.startsWith\(\s*(\w+)\s*\)/);
  if (!match) bad.push("the fetch handler does not scope by pathname");
  else {
    const name = match[1];
    const decl = src.match(new RegExp(`const\\s+${name}\\s*=\\s*["']([^"']+)["']`));
    if (!decl) bad.push(`the scoped path ${name} is not a declared constant`);
    else if (!decl[1].endsWith("/")) bad.push(`the scoped path is "${decl[1]}" — an exact-match route is too narrow`);
  }
  // Anything that would widen the blast radius.
  for (const [name, re] of [
    ["navigation requests", /mode\s*===\s*["']navigate["']\s*&&\s*(?:cache|respondWith)/],
    ["a catch-all path match", /pathname\s*===\s*["']\/["']\s*\)?\s*(?:,|\n)/],
    ["caching by ignoring ok", /cache\.put\([^)]*\)\s*;?\s*\n\s*\}\s*\n\s*return\s+res/],
  ] as const) {
    if (re.test(src)) bad.push(`the worker appears to cache ${name}`);
  }

  // The 502 rule, stated as: cache.put is reachable only through an ok check.
  const put = src.indexOf("cache.put");
  if (put < 0) bad.push("the worker never writes to the cache");
  else {
    const before = src.slice(Math.max(0, put - 200), put);
    if (!/res\.ok/.test(before)) bad.push("cache.put is not guarded on res.ok — a 502 from the upstream would be cached forever");
  }
  // A second put that is not the guarded one would undo the rule above.
  if (src.indexOf("cache.put", put + 1) >= 0) bad.push("more than one cache.put — one of them is unguarded");

  if (!/clients\.claim\(\)/.test(src)) bad.push("the worker never claims clients, so it would not take effect until every tab closed");
  if (!/addEventListener\(\s*["']activate["']/.test(src)) bad.push("no activate handler, so an older cache could never be purged");
  if (!/caches\.delete\(/.test(src)) bad.push("the activate handler does not purge superseded caches");

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

// ------------------------------------------------- the worker, and who gets it

const sw = readFileSync(path.join(REPO, "public/sw.js"), "utf8");
const swFindings = auditWorker(sw);
for (const f of swFindings) console.log(`  FAIL  sw.js: ${f}`);
ok(
  swFindings.length === 0,
  "the service worker caches album art and nothing else, and never caches a failure",
  swFindings
);

{
  // The reason the worker can hold anything at all: the page registers it for
  // anyone listening. It used to be registered only on the push path, which is
  // admin-only and permission-gated — so the cache could never be filled for an
  // ordinary listener, and the whole feature was dead on arrival for them.
  ok(/serviceWorker\.register\(/.test(raw), "the page registers the worker");
  const regStart = raw.indexOf("if (!isApprovedPlayer) return;");
  const regBlock = regStart < 0 ? "" : raw.slice(regStart, raw.indexOf("serviceWorker.register", regStart));
  ok(regBlock.length > 0, "and does so from a guard that admits any approved player");
  ok(
    regBlock.length > 0 && !/isAdmin/.test(regBlock),
    "and that guard is not admin-only — the admin gate is why listeners had no worker at all"
  );
  // The push registration below it IS admin-only, and correctly so: push is for
  // the operator. Asserted separately so it cannot be "fixed" into the art path.
  ok(
    /isAdmin\) return;[\s\S]{0,400}serviceWorker\.register/.test(raw),
    "while the push registration stays admin-only, which is correct and separate"
  );
  ok(/swRegisteredRef/.test(raw), "registration is guarded so the 5s poll does not re-register every tick");
}

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

// ------------------------------------------------------ the worker's own tests

const GOOD_SW = `
const COVER_PATH = "/api/cover/";
const COVER_CACHE = "causewayfm-cover-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const n of await caches.keys()) if (n !== COVER_CACHE) await caches.delete(n);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url; try { url = new URL(req.url); } catch { return; }
  if (!url.pathname.startsWith(COVER_PATH)) return;
  event.respondWith((async () => {
    const cache = await caches.open(COVER_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req.url, { mode: "cors", credentials: "omit" });
      if (res.ok) { await cache.put(req, res.clone()); }
      return res;
    } catch (e) { return fetch(req); }
  })());
});
self.addEventListener("push", (event) => { event.waitUntil(Promise.resolve()); });`;

ok(auditWorker(GOOD_SW).length === 0, "a correctly scoped worker passes", auditWorker(GOOD_SW));

{
  // The exact mistake that would undo the original design decision: cache
  // everything. Served from cache, a stale application shell is a bug nobody
  // can diagnose from the symptoms.
  const f = auditWorker(GOOD_SW.replace('if (!url.pathname.startsWith(COVER_PATH)) return;', ""));
  ok(f.some((x) => /no session check|scope|catch-all/.test(x)) || auditWorker(GOOD_SW.replace('if (!url.pathname.startsWith(COVER_PATH)) return;', "")).length > 0, "an unscoped fetch handler is caught", f);
}

{
  // The 502. Cache-first plus an unreadable status means a failed upstream
  // response becomes permanent artwork damage.
  const f = auditWorker(GOOD_SW.replace("if (res.ok) { await cache.put(req, res.clone()); }", "await cache.put(req, res.clone());"));
  ok(f.some((x) => /not guarded on res\.ok/.test(x)), "an unguarded cache.put is caught", f);
}

{
  const f = auditWorker(GOOD_SW.replace('if (req.method !== "GET") return;', ""));
  ok(f.some((x) => /non-GET/.test(x)), "a handler that does not exclude non-GET is caught", f);
}

{
  const f = auditWorker(GOOD_SW.replace("await self.clients.claim();", ""));
  ok(f.some((x) => /claims clients/.test(x)), "a worker that never claims clients is caught", f);
}

{
  const f = auditWorker(GOOD_SW.replace("await caches.delete(n);", ""));
  ok(f.some((x) => /purge superseded caches/.test(x)), "an activate handler that cannot purge old caches is caught", f);
}

{
  const f = auditWorker(GOOD_SW.replace('self.addEventListener("push", (event) => { event.waitUntil(Promise.resolve()); });', ""));
  ok(f.some((x) => /push handler is gone/.test(x)), "a worker that lost its push handler is caught", f);
}

{
  ok(auditWorker("// nothing here").length > 0, "a worker with no caching at all is a failure, not a pass");
}

console.log(`  ${passed}/${passed + failed} art-prefetch assertions passed`);
if (failed) process.exit(1);