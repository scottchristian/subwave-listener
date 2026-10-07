// Documents must never be revalidated into an empty one.
//
// The failure: `/` was prerendered with an ETag, so a reload was a
// *revalidation*. We answered "304 Not Modified" — no body, by design — and a
// browser whose stored body a hard reload had already dropped was left holding
// a valid cache entry and nothing to render. "This page couldn't load", forever,
// only in profiles that had been here before, never in a private window, while
// every subresource fetched perfectly. It reads as a network fault and is not.
//
// These assertions are about the header contract, since that is the only thing
// that decides whether a browser is ever told "reuse your copy" about a document
// whose copy it may not have.
// Run: node scripts/check-cache-headers.mts (wired as `npm run check:cache`).
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

// Parse the header rules out of next.config the way Next does: source + headers,
// in order, later rules winning for a path that matches more than one.
const configSrc = readFileSync(path.join(REPO, "next.config.ts"), "utf8");

type Rule = { source: string; headers: Record<string, string> };
const rules: Rule[] = [];
const ruleRe = /source:\s*'([^']+)'\s*,\s*headers:\s*\[([\s\S]*?)\]/g;
let m: RegExpExecArray | null;
while ((m = ruleRe.exec(configSrc))) {
  const headers: Record<string, string> = {};
  for (const h of m[2].matchAll(/key:\s*'([^']+)'\s*,\s*value:\s*'([^']*)'/g)) {
    headers[h[1].toLowerCase()] = h[2];
  }
  rules.push({ source: m[1], headers });
}

ok(rules.length >= 3, "the config declares the document and asset rules separately", rules.length);

/**
 * Next applies header rules in order and a later matching rule wins, so a path
 * takes its Cache-Control from the LAST rule that matches it. A rule matches
 * everything if it is a catch-all (`/(.*)`, `/:path*`), or only the paths under
 * its literal prefix if it has one (`/_next/static/:path*`).
 *
 * Getting this wrong is not a cosmetic test bug: treat /brand/:path* as a
 * catch-all and every document looks like brand artwork, which is exactly the
 * kind of mistake that lets a bad header rule ship.
 */
function headersFor(p: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rules) {
    // Strip only the trailing wildcard, keeping the leading slash, so
    // "/_next/static/:path*" yields the prefix "/_next/static" and a test path of
    // "/_next/static/chunks/x.js" actually sits under it.
    const prefix = r.source.replace(/\/\(\.\*\)$/, "").replace(/\/:path\*$/, "");
    if (prefix === "" || p === prefix || p.startsWith(prefix + "/")) {
      Object.assign(out, r.headers);
    }
  }
  return out;
}

/** Would a browser be told it may revalidate instead of refetching? */
function allowsRevalidation(cacheControl: string | undefined): boolean {
  if (!cacheControl) return true; // no directive at all -> heuristically cacheable
  const cc = cacheControl.toLowerCase();
  if (cc.includes("no-store") || cc.includes("no-cache")) return false;
  if (cc.includes("must-revalidate")) return false;
  // s-maxage alone constrains SHARED caches only, so a browser still treats the
  // response as cacheable — this is exactly the trap the ETag walked us into.
  const browserDirectives = cc
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.startsWith("max-age=") || d.startsWith("s-maxage=") === false);
  return browserDirectives.length > 0;
}

const doc = headersFor("/");
const signin = headersFor("/signin");
const authError = headersFor("/auth-error");
const unavailable = headersFor("/unavailable");

for (const [path, headers] of [["/", doc], ["/signin", signin], ["/auth-error", authError], ["/unavailable", unavailable]] as const) {
  ok(
    allowsRevalidation(headers["cache-control"]) === false,
    `${path} cannot be revalidated into an empty body`,
    headers["cache-control"]
  );
  ok(
    (headers["cache-control"] || "").toLowerCase().includes("no-store"),
    `${path} says no-store outright`,
    headers["cache-control"]
  );
}

// The ETag is what turns a reload into a revalidation in the first place. With
// no-store a conforming client must not revalidate, but the station should also
// not be handing out a validator for a document it insists on never reusing.
const swDoc = headersFor("/sw.js");
ok(allowsRevalidation(swDoc["cache-control"]) === false, "/sw.js is fetched fresh, so a new worker installs promptly", swDoc["cache-control"]);

// Content-addressed bundles are the one thing a year of caching is correct for:
// the filename changes whenever the bytes do, so an immutable entry can never go
// stale. Losing this would mean re-downloading the whole app on every visit.
const asset = headersFor("/_next/static/chunks/abc123.js");
ok((asset["cache-control"] || "").includes("immutable"), "hashed bundles stay immutable", asset["cache-control"]);
ok(
  Number((asset["cache-control"] || "").match(/max-age=(\d+)/)?.[1] ?? 0) >= 31_536_000,
  "for a year",
  asset["cache-control"]
);

// Branding is content-stable but not content-addressed, so it must not be
// immutable — but it is 214KB of background, so it must still be storable and
// revalidatable, or every visit re-downloads it.
const brand = headersFor("/brand/logo.png");
ok(!(brand["cache-control"] || "").includes("immutable"), "brand artwork is not immutable", brand["cache-control"]);
ok(!(brand["cache-control"] || "").includes("no-store"), "brand artwork can be stored", brand["cache-control"]);
ok(
  (brand["cache-control"] || "").toLowerCase().includes("must-revalidate"),
  "and is revalidated rather than trusted blindly",
  brand["cache-control"]
);

// The noindex guard predates all of this and must survive the rewrite.
ok(doc["x-robots-tag"] === "noindex, nofollow, noarchive", "the noindex guard is still applied", doc["x-robots-tag"]);

console.log(`  ${passed}/${passed + failed} cache-header assertions passed`);
if (failed) process.exit(1);
