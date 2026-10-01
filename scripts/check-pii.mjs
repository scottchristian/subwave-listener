#!/usr/bin/env node
// Regression guard for the PII rule in DEPLOY.md: no response may hand out a
// stored encrypted value.
//
// Deliberately not a general static analyser. Inferring "was this column
// decrypted?" from source is guesswork, and a check that cries wolf gets
// ignored — which is worse than no check. So this only fails on patterns that
// are unambiguous, and reports the rest for a human to confirm.
//
//   node scripts/check-pii.mjs     (from the repo root)
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = walk("app/api");

// Columns that must never appear in any response, in any form.
const NEVER_LEAVE = [
  { col: "supporterEmailIdx", why: "deterministic blind index — a stable per-person token" },
  { col: "refresh_token", why: "OAuth token" },
  { col: "access_token", why: "OAuth token" },
  { col: "id_token", why: "OAuth token" },
];

// Columns that are encrypted at rest and must be passed through lib/pii.
const ENCRYPTED = ["supporterName", "supporterEmail", "nickname", "emailEnc"];

// A spread entry inside an object literal, in either shape: alone on its own
// line, or inline as `({ ...d })`. Anchoring on the opening brace keeps
// function-call spreads like `fn(...args)` out of the results.
const SPREAD = /\{\s*\.\.\.\s*[a-zA-Z_$][\w$]*\s*[,}]|^\s*\.\.\.\s*[a-zA-Z_$][\w$]*\s*,\s*$/m;

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

let failures = 0;
const fail = (f, msg) => {
  console.log(`  FAIL  ${f}\n          ${msg}`);
  failures++;
};
const report = (f, msg) => console.log(`  check ${f}\n          ${msg}`);

console.log("=== never-leave columns ===");
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const { col, why } of NEVER_LEAVE) {
    const re = new RegExp(`\\b${col}\\s*:\\s*true`);
    if (re.test(src)) {
      fail(f, `line ${lineOf(src, src.search(re))}: selects \`${col}\` — ${why}`);
    }
  }
}

console.log("\n=== encrypted columns reaching a response ===");
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (!/NextResponse\.json/.test(src)) continue;

  // The precise form of the original bug: mapping a query result and spreading
  // the row itself. The back-reference can only be the map's own parameter, so
  // this shape cannot be a coincidence. A file spreading some *unrelated*
  // object elsewhere is deliberately not flagged — missing a leak is a better
  // failure mode than crying wolf on a correct route, because a check that
  // always fires is a check nobody runs.
  const selfSpread = src.match(/\.map\(\s*\((\w+)\)\s*=>\s*\(\{\s*\.\.\.\s*\1\s*[,}]/);
  if (selfSpread) {
    fail(
      f,
      `line ${lineOf(src, src.indexOf(selfSpread[0]))}: maps the query result and spreads the row itself — ` +
        "every encrypted column ships, including ones no select names. Build the response as a whitelist."
    );
  }

  const spread = src.match(SPREAD);
  if (spread) {
    for (const col of ENCRYPTED) {
      const sel = new RegExp(`\\b${col}\\s*:\\s*true`);
      if (!sel.test(src)) continue;
      const spreadLine = lineOf(src, src.search(spread));
      // Does the response reference the raw column at all, rather than a
      // helper? A helper call proves handling; a bare `x.col` does not.
      const rawUse = new RegExp(`\\.[a-zA-Z_$][\\w$]*\\s*\\.\\s*${col}\\b|\\b${col}\\s*,\\s*\\n`);
      if (rawUse.test(src)) {
        fail(
          f,
          `selects \`${col}\` and spreads a row (line ${spreadLine}) while still reading \`${col}\` raw`
        );
      } else {
        report(f, `selects \`${col}\` and spreads a row, but the raw column never appears — confirm it is decrypted`);
      }
    }
  }

  // A relation selected with a bare `true` loads every column of it. Safe
  // today only because the response rebuilds the output; flag for review.
  const bareTrue = src.match(/\b(donations|accounts|streamSessions|songLikes)\s*:\s*true/g);
  if (bareTrue) {
    for (const m of bareTrue) {
      const rel = m.trim().split(":")[0];
      const re = new RegExp(`\\b${rel}\\s*:\\s*\\{`);
      if (re.test(src.split("NextResponse.json")[0]?.slice(-400) || "")) {
        // reassigned in the response, which is the safe shape
        continue;
      }
      report(f, `\`${m.trim()}\` loads every column of ${rel} — confirm it is not returned as-is`);
    }
  }
}

// Endpoints that hand out personal data and must therefore require a session.
// Each entry was reviewed by hand; a stale entry here is worse than a missing
// one, so this list is the contract rather than a guess.
const MUST_BE_GATED = {
  "app/api/likes/route.ts": "returns a decrypted name and avatar for every listener on a track",
};

console.log("\n=== gates on personal-data endpoints ===");
for (const [f, why] of Object.entries(MUST_BE_GATED)) {
  const src = readFileSync(f, "utf8");
  // Scope to the GET handler only. Slicing to end-of-file would also pick up
  // the POST handler, which checks isApproved too, so removing the gate from
  // GET alone would still read as "ok" — a real false negative I hit.
  const at = src.indexOf("export async function GET");
  if (at === -1) {
    fail(f, "listed as serving personal data but has no GET handler — review the list");
    continue;
  }
  const rest = src.slice(at);
  const next = rest.indexOf("export async function", 1);
  const get = next === -1 ? rest : rest.slice(0, next);
  if (!/getServerSession/.test(get)) {
    fail(f, `GET serves personal data (${why}) but never calls getServerSession`);
  } else if (!/isApproved/.test(get)) {
    fail(f, `GET serves personal data (${why}) but does not check isApproved`);
  } else {
    console.log(`  ok    ${f} — session and approval both checked`);
  }
}

console.log(
  failures === 0
    ? "\nNo unambiguous PII leaks. Review anything marked 'check'."
    : `\n${failures} unambiguous leak(s).`
);
process.exit(failures === 0 ? 0 : 1);
