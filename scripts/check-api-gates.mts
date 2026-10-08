// Every route handler is reachable, closed, and closed for a stated reason.
//
// This exists because two opposite failures shipped this session, both silent:
//
//   1. A route that could never run. `app/api/client-error` was built, wired
//      into the app, and answered 401 for itself — proxy.ts gates every /api
//      path behind a session and the route was not in the PUBLIC allowlist. It
//      is a crash REPORTER, so the failures it exists to catch are precisely
//      the ones where nobody holds a session; it had been dropping the reports
//      that mattered, and nothing said so until someone called it by hand.
//
//   2. A route that was open when nobody meant it to be. Buy Me A Coffee posts
//      to /api/webhooks/bmac from the internet and cannot present a session, so
//      that one is deliberately public — but it verifies an HMAC of its own
//      body, and the reason is written next to the entry. A new route has no
//      such protection by default.
//
// So each route handler must land in exactly one of three places, and the
// residue is asserted in BOTH directions:
//
//   PUBLIC      in proxy.ts's allowlist, with a written reason.
//   SELF-CHECKED  establishes who is calling itself (a session, an admin check,
//               an HMAC, or the setup-complete marker).
//   PROXY-ONLY  deliberately relies on the proxy alone, listed here by hand with
//               a reason. This is the residue, and it is supposed to stay tiny —
//               a new route that lands in it fails the check until someone says
//               why, which is the review that should have happened anyway.
//
// Plus the mechanical invariant both halves need: every route handler's URL path
// is either under a prefix proxy.ts's matcher gates, or on the PUBLIC list. A
// handler dropped at some new top-level path is invisible to the gate, and that
// is failure 2 again by accident rather than on purpose.
//
// This reads the code, not the running app, so it is instant and hermetic.
//
// Run: node scripts/check-api-gates.mts (wired as `npm run check:api-gates`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrub, walkTs } from "./lib/tsx-scan.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const PROXY = path.join(REPO, "proxy.ts");

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

// -------------------------------------------------------- proxy.ts, read

const proxySrc = readFileSync(PROXY, "utf8");

function between(start: string, end: string): string {
  const a = proxySrc.indexOf(start);
  if (a < 0) throw new Error(`proxy.ts no longer contains ${start} — this check cannot read the gate`);
  const b = proxySrc.indexOf(end, a);
  if (b < 0) throw new Error(`proxy.ts has no ${end} after ${start}`);
  return proxySrc.slice(a, b);
}

/** proxy.ts's own matcher, as prefixes: "/api/:path*" -> "/api". */
const GATED_PREFIXES = [...between("matcher: [", "]").matchAll(/"([^"]+?)(?::path\*)?"/g)].map(
  (m) => m[1].replace(/\/$/, "")
);

const PUBLIC_ENTRIES: { path: string; why: string }[] = [
  ...between("const PUBLIC = [", "];").matchAll(/\{\s*path:\s*"([^"]+)"\s*,\s*why:\s*"([^"]*)"\s*\}/g),
].map((m) => ({ path: m[1], why: m[2] }));

/** proxy.ts matches `pathname === p || pathname.startsWith(p + "/")`. */
function isPublicPath(routePath: string): boolean {
  return PUBLIC_ENTRIES.some((p) => routePath === p.path || routePath.startsWith(p.path + "/"));
}
function publicEntryFor(routePath: string) {
  return PUBLIC_ENTRIES.find((p) => routePath === p.path || routePath.startsWith(p.path + "/"));
}

// -------------------------------------------------------- the residual

/**
 * Routes that deliberately have no check of their own, each with the reason.
 *
 * Two different shapes land here, and both need the reason written down:
 *   - behind the gate, where the proxy IS the check (/api/links: track metadata
 *     that a signed-out visitor must not see, so the proxy is the whole point)
 *   - outside the gate entirely, where there is nothing to check because there
 *     is nothing to protect (/brand: public artwork)
 *
 * Keep this short. A new route landing here fails the check until someone says
 * why, which is the review that should have happened anyway.
 */
const OPEN_BY_DESIGN: Record<string, string> = {
  "/api/links": "returns track metadata for a signed-in listener; the proxy is the only check, which is correct because a signed-out visitor must not see the track at all",
  "/brand": "public brand artwork with nothing behind it; it reads no session and exposes no station state, so there is nothing for a check to protect",
};

const SELF_CHECKS: { name: string; re: RegExp }[] = [
  { name: "getServerSession", re: /await\s+getServerSession\s*\(/ },
  { name: "cachedSession", re: /await\s+cachedSession\s*\(/ },
  { name: "requireAdmin", re: /await\s+requireAdmin\s*\(/ },
  { name: "requireUser", re: /await\s+requireUser\s*\(/ },
  { name: "adminFetch", re: /await\s+adminFetch\s*\(/ },
  { name: "verifyHmac", re: /verifyHmac\s*\(/ },
  { name: "isSetupComplete", re: /isSetupComplete\s*\(\s*\)/ },
];

// -------------------------------------------------------- the routes

/** Every route handler in the app, not just app/api — a handler elsewhere is the open one. */
const routes = walkTs(path.join(REPO, "app")).filter((f) => f.endsWith("route.ts"));

/** `/api/foo/[...bar]` -> `/api/foo`, the part the gate can see. */
function gatePath(file: string): string {
  const rel = path.relative(path.join(REPO, "app"), path.dirname(file));
  return "/" + rel.split(path.sep).filter((s) => !s.startsWith("[")).join("/");
}

ok(routes.length > 20, `found the route handlers (${routes.length})`);

const accidentallyOpen: string[] = [];
const unjustified: string[] = [];
const unlisted: string[] = [];
const stale: string[] = [];
const unusedCheck: string[] = [];

for (const file of routes) {
  const rel = "/" + path.relative(REPO, file);
  const at = gatePath(file);
  const code = scrub(readFileSync(file, "utf8"));
  const entry = publicEntryFor(at);

  if (!entry && !OPEN_BY_DESIGN[at] && !GATED_PREFIXES.some((p) => at === p || at.startsWith(p + "/"))) {
    accidentallyOpen.push(`${rel} — ${at} is under no gated prefix, is not on the PUBLIC list, and has no stated reason for being open`);
  }
  if (entry && entry.why.trim().length < 20) {
    unjustified.push(`${rel} — PUBLIC entry "${entry.path}" says "${entry.why}"`);
  }

  const used = SELF_CHECKS.filter((c) => c.re.test(code)).map((c) => c.name);

  // A check that is imported but never called is the shape a check takes when a
  // refactor removes the call and leaves the import behind.
  for (const c of SELF_CHECKS) {
    if (new RegExp(`import[^;]*\\b${c.name}\\b`).test(code) && !c.re.test(code)) {
      unusedCheck.push(`${rel} imports ${c.name} but never calls it`);
    }
  }

  const isResidual = !entry && used.length === 0;
  if (isResidual && !OPEN_BY_DESIGN[at]) unlisted.push(`${rel} — no session check, not public, and not listed as deliberately open`);
  if (!isResidual && OPEN_BY_DESIGN[at]) stale.push(`${rel} — listed as deliberately open, but it now ${entry ? "sits on the PUBLIC list" : `checks via ${used.join(", ")}`}`);
}

for (const r of accidentallyOpen) console.log(`  FAIL  open: ${r}`);
for (const r of unjustified) console.log(`  FAIL  unjustified: ${r}`);
for (const r of unlisted) console.log(`  FAIL  unlisted: ${r}`);
for (const r of stale) console.log(`  FAIL  stale: ${r}`);
for (const r of unusedCheck) console.log(`  FAIL  unused: ${r}`);

ok(accidentallyOpen.length === 0, "no route handler sits outside the gate", accidentallyOpen);
ok(unjustified.length === 0, "every PUBLIC entry says why, in a sentence", unjustified);
ok(unlisted.length === 0, "every route that checks nobody is listed as deliberate", unlisted);
ok(stale.length === 0, "the deliberate list still matches reality", stale);
ok(unusedCheck.length === 0, "no route imports an auth helper without calling it", unusedCheck);
ok(
  Object.keys(OPEN_BY_DESIGN).length <= 5,
  `routes with no check of their own stay rare (${Object.keys(OPEN_BY_DESIGN).length})`
);

// -------------------------------------------------------- the checker checks itself

{
  // Parsers must not be satisfied by a stub, or this file degrades into a check
  // that finds nothing — the failure mode that hid a hook bug for hours.
  const shaped = [...`{ path: "/api/thing", why: "a reason long enough to be a real reason" }`.matchAll(
    /\{\s*path:\s*"([^"]+)"\s*,\s*why:\s*"([^"]*)"\s*\}/g
  )];
  ok(shaped.length === 1 && shaped[0][1] === "/api/thing", "the PUBLIC parser reads a well-formed entry", shaped.length);

  const bare = [...`{ path: "/api/thing" }`.matchAll(/\{\s*path:\s*"([^"]+)"\s*,\s*why:\s*"([^"]*)"\s*\}/g)];
  ok(bare.length === 0, "and rejects an entry carrying no reason at all");
}

ok(PUBLIC_ENTRIES.length > 0 && GATED_PREFIXES.length > 0, "both lists were actually read out of proxy.ts");
ok(
  PUBLIC_ENTRIES.some((p) => p.path === "/api/auth"),
  "including /api/auth"
);
ok(GATED_PREFIXES.includes("/api"), "and the matcher covers /api");

// Composition, not just the pieces: these go through gatePath, because the bug
// that shipped was a correct isPublicPath fed a path that dropped the /api
// prefix, and every hand-written literal in the self-tests still passed.
ok(isPublicPath(gatePath(path.join(REPO, "app/api/client-error/route.ts"))), "gatePath yields the gated path, and the crash reporter is public");
ok(isPublicPath(gatePath(path.join(REPO, "app/api/auth/[...nextauth]/route.ts"))), "and NextAuth's dynamic segment resolves to /api/auth");
ok(!isPublicPath(gatePath(path.join(REPO, "app/api/links/route.ts"))), "while a gated route is not public");
ok(
  GATED_PREFIXES.some((p) => gatePath(path.join(REPO, "app/api/links/route.ts")).startsWith(p + "/")),
  "and is still under a gated prefix, which is why it is safe"
);

ok(
  routes.filter((f) => f.includes("client-error")).length === 1,
  "the walk found exactly one crash reporter — the one the gate list is talking about"
);

console.log(`  ${passed}/${passed + failed} api-gate assertions passed`);
if (failed) process.exit(1);