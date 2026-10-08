// What may reach a log, and what a publicly-writable endpoint may be handed.
//
// check-pii.mjs already guards RESPONSES — no encrypted column leaves in a
// response body. This guards the other half of the same rule: what gets written
// to a log file on disk, which is read by whoever has the machine and survives
// the request that caused it.
//
// The sharpest case is the crash reporter. It is deliberately PUBLIC (see
// proxy.ts) because a render crash very often happens during sign-in, when
// nobody holds a session — so it is publicly WRITABLE. Anything it accepts from
// an anonymous stranger becomes a line in a file the operator reads, which makes
// it the one endpoint where "just log the request body" would quietly turn into
// a place to write arbitrary text and read it back out of the machine's own logs.
//
// So the rules here are:
//
//   - the payload is an explicit whitelist, not a spread of the body
//   - every field in it is length-capped, and the entry is capped as a whole
//   - the file stops growing at a ceiling
//   - a disk failure cannot throw (a crash reporter that throws is a second crash)
//   - it reads no session, no cookie, no authorization header
//   - and on the client, only the error's own message, name and component stack
//     are sent — no props, no session, no track metadata
//
// It also pins the query audit, which is the app's other disk log: it tallies
// Prisma's `model.action` per query and must never carry `args`. Those are the
// row values, and they are exactly the track titles and supporter names the
// no-PII-in-logs rule is about.
//
// Every parser below FAILS if it finds nothing. A check that silently matches
// zero things is worse than no check — that failure mode hid a hook-order bug
// for hours, through two different versions of the checker meant to catch it.
//
// Run: node scripts/check-privacy-boundaries.mts (wired as `npm run check:privacy`).
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

/** Names that must never be handed to a log: credentials, identity, or the track. */
const NEVER_LOG = /cookie|token|secret|password|email|session|authoriz|supporter|nickname|display|track|artist|album|\btitle\b|\bip\b|address|user-?agent/i;

/** The one exception, deliberately: it is how a crash report is attributed. */
const ALLOWED_FIELDS = new Set(["at", "name", "message", "componentStack", "ua"]);

/**
 * Top-level keys of the first object literal passed to JSON.stringify.
 * Throws rather than returning [] when it cannot find one.
 */
function payloadKeys(src: string, where: string): string[] {
  const at = src.indexOf("JSON.stringify");
  if (at < 0) throw new Error(`${where}: no JSON.stringify call to read`);
  const open = src.indexOf("{", at);
  if (open < 0) throw new Error(`${where}: JSON.stringify has no object literal`);
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (--depth === 0) break;
    } else if (ch === "}") throw new Error(`${where}: unbalanced braces`);
    // Only keys at depth 1 count; a nested object's keys belong to it.
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(src.slice(i));
      if (m) {
        keys.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  if (!keys.length) throw new Error(`${where}: parsed an object with no keys — the parser is broken`);
  return keys;
}

// ------------------------------------------------- the crash reporter route

const ROUTE = path.join(REPO, "app/api/client-error/route.ts");
const route = readFileSync(ROUTE, "utf8");
const okRoute = route.length > 0;
ok(okRoute, "found the crash reporter route");

{
  const keys = payloadKeys(route, "crash reporter");
  ok(keys.length >= 3, `parsed the reporter's written fields (${keys.join(", ")})`, keys);

  const forbidden = keys.filter((k) => NEVER_LOG.test(k) && !ALLOWED_FIELDS.has(k));
  ok(forbidden.length === 0, "no written field is a credential, an identity, or the track", forbidden);

  const unexpected = keys.filter((k) => !ALLOWED_FIELDS.has(k));
  ok(
    unexpected.length === 0,
    "the written fields are exactly the whitelist, so a new field has to be a decision",
    unexpected
  );

  // A whitelist is only a whitelist if nothing else gets in. A spread of the
  // request body would carry every field an anonymous caller sends, which is the
  // exact shape that turns a log into a write-what-you-want channel.
  const spread = route.match(/JSON\.stringify\(\s*\{\s*\.\.\./);
  ok(spread === null, "the entry is built field by field, never by spreading the request body");

  const uncapped = keys.filter((k) => !new RegExp(`\\b${k}\\s*:\\s*oneLine\\(`).test(route));
  ok(uncapped.length === 0, "every written field passes through the cap", uncapped);

  ok(/MAX_FIELD\s*=\s*\d+/.test(route), "there is a per-field cap");
  ok(/MAX_BODY\s*=\s*\d+/.test(route), "and a cap on the entry as a whole");
  ok(/\.slice\(0,\s*MAX_BODY\)/.test(route), "and the entry cap is actually applied");
  ok(/oneLine\([\s\S]*?\.slice\(0,\s*cap\)/.test(route), "and the per-field cap is actually applied");

  // Publicly writable means anyone can POST here, so the file cannot be
  // something any caller can grow without bound.
  ok(/LOG_MAX_BYTES\s*=\s*\d+/.test(route), "the log has a byte ceiling");
  ok(
    /size\s*<\s*LOG_MAX_BYTES\s*\)[\s\S]{0,80}?appendFileSync/.test(route),
    "and the append is skipped once the file passes it"
  );
  ok(
    /try\s*\{[\s\S]*?appendFileSync[\s\S]*?\}\s*catch/.test(route),
    "a full or read-only disk cannot throw out of the reporter"
  );

  ok(!/getServerSession|cachedSession|cookies\(\)|req\.headers\.get\(\s*["']authorization/i.test(route), "it reads no session, no cookie, no authorization header");
  ok(!/NEXT_PUBLIC|process\.env\.[A-Z_]*SECRET/i.test(scrub(route)), "it reads no secret from the environment");
}

// ------------------------------------------------------- the client boundary

const BOUNDARY = path.join(REPO, "app/components/CaptureBoundary.tsx");
const boundary = readFileSync(BOUNDARY, "utf8");

{
  const keys = payloadKeys(boundary, "CaptureBoundary");
  ok(keys.length >= 2, `parsed what the browser sends (${keys.join(", ")})`, keys);

  const forbidden = keys.filter((k) => NEVER_LOG.test(k) && !ALLOWED_FIELDS.has(k));
  ok(forbidden.length === 0, "the browser sends no credential, identity, or track field", forbidden);

  // The server whitelists, but a browser that sent more would still be putting
  // it on the wire, where anything between here and there could read it.
  //
  // Scoped to componentDidCatch, and scrubbed first: the class's own doc comment
  // contains the words "No props, no session, no track metadata", and a
  // substring search happily fails on the very sentence describing the rule.
  const reporting = scrub(boundary.split("componentDidCatch")[1]?.split("render()")[0] ?? "");
  ok(reporting.length > 0, "the reporting method could be isolated");
  ok(
    !/document\.cookie|localStorage|sessionStorage|useSession|\bprops\b/.test(reporting),
    "the report is built without reading cookies, storage, or props"
  );
  ok(
    /componentDidCatch/.test(boundary) && /sendBeacon|fetch\(\s*"\/api\/client-error"/.test(boundary),
    "and it reports from componentDidCatch, so the stack is available"
  );
}

// ------------------------------------------------------- the query audit

const PRISMA = path.join(REPO, "lib/prisma.ts");
const prisma = readFileSync(PRISMA, "utf8");

{
  const audit = prisma.match(/appendFileSync\(auditPath\(\),\s*([\s\S]*?)\);/);
  ok(audit !== null, "found the query-audit append");
  const line = audit?.[1] ?? "";
  // `model.action` is a Prisma-supplied identifier. `args` is the row values:
  // track titles, supporter names, tokens. Adding args to debug "which query is
  // this" is the obvious next edit, and it is the one this rule exists to stop.
  ok(!/args\b/.test(line), "the audit line carries no query arguments", line.trim());
  ok(!/params\s*\[\s*["']where["']/.test(line), "and no where clause");
  ok(!/JSON\.stringify/.test(line), "and no serialised payload of any kind");
  ok(
    /appendFileSync\(auditPath\(\)[\s\S]{0,200}?catch/.test(prisma),
    "and a failed audit write cannot break the query it observes"
  );
  ok(/path\.join\(process\.cwd\(\),\s*"data"/.test(prisma), "the audit is a local file, never the database");
}

// ------------------------------------------------- the checker checks itself

{
  // A parser that finds nothing must fail. This is the whole lesson.
  let threw = false;
  try {
    payloadKeys("const x = 1;", "empty source");
  } catch {
    threw = true;
  }
  ok(threw, "the field parser fails loudly on a source with no JSON.stringify");

  let emptyThrew = false;
  try {
    payloadKeys("JSON.stringify({})", "no keys");
  } catch {
    emptyThrew = true;
  }
  ok(emptyThrew, "and on an object with no keys");

  ok(payloadKeys('JSON.stringify({ a: 1, nested: { b: 2 }, c: 3 })', "nesting") .join(",") === "a,nested,c",
    "and reads only the top-level keys");
}

{
  const names = ["cookies", "refresh_token", "supporterEmail", "trackTitle", "userAgent"];
  const caught = names.filter((n) => NEVER_LOG.test(n) && !ALLOWED_FIELDS.has(n));
  ok(caught.length === names.length, "the forbidden-name rule catches all five obvious cases", caught);
  ok(!NEVER_LOG.test("ua"), "while allowing the user-agent field it is meant to allow");
}

console.log(`  ${passed}/${passed + failed} privacy-boundary assertions passed`);
if (failed) process.exit(1);