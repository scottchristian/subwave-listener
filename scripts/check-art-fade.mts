// The album art must crossfade between pictures, not snap.
//
// The player used to swap a single <img src>, which replaces the pixels outright
// — React's `key` on subsonic_id remounts the element, so there is no prior
// opacity for a transition to start from. It now keeps two layers: the outgoing
// cover mounted underneath, the incoming one fading in on top.
//
// There is one way to write this that looks right and is visibly broken, and it
// is the way that writes itself:
//
//   on track change -> fade the OLD cover out immediately -> wait for the new
//   one to arrive -> fade it in
//
// That fades to an empty box for as long as the fetch takes. On a warm cache it
// is fine; on a cold one it is a visible flash of nothing, which reads worse
// than having no transition at all. So the invariant pinned here is the ORDER:
// the outgoing layer must be held at full opacity until the incoming one has
// actually loaded, and only then may both transition together.
//
// The second thing this file exists to prevent is a "clever" rewrite. The commit
// animation that was removed earlier did the same visual job with
// document.startViewTransition and flushSync called from a promise callback,
// which re-enters React's renderer from outside its own scheduling and cost
// hours of misdiagnosis during a two-day outage. Two declarative layers with a
// CSS transition cannot do that. check-commit-path.mts already bans the banned
// spellings; this asserts the shape those bans exist to protect.
//
// Run: node scripts/check-art-fade.mts (wired as `npm run check:art-fade`).
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

/**
 * Reasons this source would fail, so the checks below can be tested.
 *
 * `code` is scrubbed of comments, because the comment explaining this feature
 * names flushSync and document.startViewTransition on purpose, and a ban that
 * trips on its own explanation is a ban that gets "fixed" by deleting the
 * explanation. `raw` is the untouched file, needed for the one check that reads
 * a string literal — scrub() blanks string bodies, so the layer className would
 * otherwise match nothing.
 */
function audit(code: string, raw: string = code): string[] {
  const bad: string[] = [];
  const src = code;

  if (!/const ART_FADE_MS\s*=\s*\d+/.test(src)) {
    bad.push("no ART_FADE_MS constant — the duration would be a literal in the JSX");
  }
  // Two layers, or there is nothing to crossfade between.
  const layers = (raw.match(/className="album-art album-art-layer"/g) ?? []).length;
  if (layers < 2) bad.push(`only ${layers} art layer(s) rendered — a single <img> cannot fade between pictures`);

  // The ordering, which is the whole point.
  if (!/art\.ready\s*\?\s*0\s*:\s*1/.test(src)) {
    bad.push("the outgoing layer is not held at full opacity until the incoming one is ready");
  }
  if (!/art\.ready\s*\?\s*1\s*:\s*0/.test(src)) {
    bad.push("the incoming layer does not start hidden and fade in");
  }
  if (!/onLoad=\{handleArtLoaded\}/.test(src)) {
    bad.push("the incoming layer reveals on something other than its own load event");
  }
  // Scoped to the load handler on purpose. This file is 3000 lines and
  // requestAnimationFrame appears twice in unrelated code, so a whole-file
  // "does it mention rAF" check is satisfied by something that has nothing to
  // do with the art — it passed a mutation that deleted the frame of grace
  // entirely. A checker that finds something and means nothing is worse than no
  // checker, which is the lesson from the hook-order checkers earlier.
  const handler = src.match(/const handleArtLoaded[\s\S]{0,900}?\}, \[\]\);/);
  if (!handler) {
    bad.push("the art load handler could not be located, so the reveal path is unchecked");
  } else if (!/requestAnimationFrame/.test(handler[0])) {
    bad.push("no frame of grace before revealing — a cached image loads fast enough to skip the fade entirely");
  } else if (!/ready:\s*true/.test(handler[0])) {
    bad.push("the reveal is not deferred into that frame — the deferral would do nothing");
  }
  if (!handler || !/cancelAnimationFrame/.test(handler[0])) {
    bad.push("the deferred frame is never cancelled, so a track change mid-fade leaks it");
  }

  // CSS opacity only. Anything that reaches into React's scheduling is the bug
  // this file is guarding.
  for (const [what, re] of [
    ["flushSync", /flushSync/],
    ["a View Transition", /startViewTransition/],
    ["a dynamic react-dom import", /import\(\s*["']react-dom["']/],
    ["a JS-driven opacity animation", /\.animate\(/],
  ] as const) {
    if (re.test(src)) bad.push(`uses ${what} — the fade must be a CSS transition`);
  }
  if (!/transition:\s*`opacity \$\{ART_FADE_MS\}ms/.test(src)) {
    bad.push("the layers do not transition opacity from the shared constant");
  }

  return bad;
}

// ------------------------------------------------------------------ the app

const pagePath = path.join(REPO, "app/page.tsx");
const raw = readFileSync(pagePath, "utf8");
const page = scrub(raw);
const css = readFileSync(path.join(REPO, "app/globals.css"), "utf8");

const findings = audit(page, raw);
for (const f of findings) console.log(`  FAIL  ${f}`);
ok(findings.length === 0, "the art crossfades, and it fades out only once the new cover has loaded", findings);

// The layers must stack rather than flow. Without absolute positioning the two
// images would sit one above the other and shove the layout down for the length
// of the fade — a jump nobody would think to blame on the transition.
//
// Extracted to the rule's own body first. A lazy match across the whole file
// finds `position: absolute` in some unrelated rule and passes anyway: that is
// exactly what the first version of this assertion did, and a mutation that
// deleted the positioning sailed through it.
function cssRule(selector: string): string | null {
  const m = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}
const layerRule = cssRule(".album-art-layer");
ok(layerRule !== null, "and .album-art-layer is defined");
ok(
  layerRule !== null && /position:\s*absolute/.test(layerRule) && /inset:\s*0/.test(layerRule),
  "and the layers are absolutely positioned, so the fade cannot reflow the layout",
  layerRule
);
const artRule = cssRule(".album-art");
ok(
  artRule !== null && /object-fit:\s*cover/.test(artRule),
  "while the art still fills its box",
  artRule
);

// A single src swap is what this replaced; if it ever comes back the fade is
// dead and nothing else would say so.
ok(
  !/id="now-playing-art"[\s\S]{0,200}src=\{`\$\{STATION_API\}\/api\/cover\/\$\{stationData/.test(raw),
  "and the now-playing art no longer derives its src directly from the poll"
);

// ------------------------------------------------- the checker checks itself

const GOOD = `
  const ART_FADE_MS = 650;
  const handleArtLoaded = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => { setArt((a) => (a ? { ...a, ready: true } : a)); });
  }, []);
  const outgoing = (
    <img key={\`out-\${art.outgoing}\`} className="album-art album-art-layer"
      style={{ opacity: art.ready ? 0 : 1, transition: \`opacity \${ART_FADE_MS}ms ease\` }} />
  );
  const incoming = (
    <img key={\`in-\${art.incoming}\`} className="album-art album-art-layer" onLoad={handleArtLoaded}
      style={{ opacity: art.ready ? 1 : 0, transition: \`opacity \${ART_FADE_MS}ms ease\` }} />
  );`;

ok(audit(GOOD).length === 0, "a correct crossfade passes", audit(GOOD));

{
  // The flash bug, written the way it writes itself.
  const f = audit(GOOD.replace("opacity: art.ready ? 0 : 1", "opacity: 0"));
  ok(f.some((x) => /held at full opacity/.test(x)), "fading the old cover out before the new one is ready is caught", f);
}

{
  const f = audit(GOOD.replace("requestAnimationFrame(() =>", "(() =>"));
  ok(f.some((x) => /frame of grace/.test(x)), "dropping the frame of grace is caught", f);
}

{
  const f = audit(GOOD.replace("cancelAnimationFrame(frameRef.current);", ""));
  ok(f.some((x) => /never cancelled/.test(x)), "leaking the deferred frame is caught", f);
}

{
  // Collapse the two layers back to one — the shape this replaced.
  const oneLayer = GOOD.replace(
    'className="album-art album-art-layer" onLoad={handleArtLoaded}\n      style={{ opacity: art.ready ? 1 : 0, transition: `opacity ${ART_FADE_MS}ms ease` }} />',
    'style={{ opacity: 1 }} />'
  );
  ok(oneLayer !== GOOD, "the single-layer fixture really did change");
  const f = audit(oneLayer);
  ok(f.some((x) => /cannot fade between pictures/.test(x)), "collapsing back to a single layer is caught", f);
}

{
  const f = audit(GOOD.replace("onLoad={handleArtLoaded}", "onLoad={() => setArt((a) => ({ ...a, ready: true }))}"));
  ok(f.some((x) => /other than its own load event/.test(x)), "revealing on something other than load is caught", f);
}

{
  // The regression that actually happened, in the shape someone might reintroduce.
  const f = audit(GOOD.replace("useCallback(() => {", "useCallback(() => { document.startViewTransition(() => {}); return;"));
  ok(f.some((x) => /View Transition/.test(x)), "reaching for a View Transition is caught", f);
}

{
  ok(audit("const x = 1;").length > 0, "a source with no crossfade at all is a failure, not a pass");
}

console.log(`  ${passed}/${passed + failed} art-fade assertions passed`);
if (failed) process.exit(1);