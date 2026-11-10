// A device must never resolve to a user. Ever. At any privilege level.
//
// WHY A STATIC AUDIT IS THE RIGHT TOOL HERE. The failure this prevents is not a
// crash and not a wrong pixel — it is a wall display quietly acting as a member
// of staff, which would show up weeks later as a station whose listener counts
// do not add up or whose requests come from a device nobody can find. It cannot
// be caught by a test that exercises the happy path, because the happy path
// works. It has to be caught by reading the source and refusing the import.
//
// Five drifts, and the rule that stops each. All of them are things a reasonable
// person does by accident when reusing a pattern from a signed-in route:
//
//   1. The device receives or stores an operator's session cookie. Sessions here
//      are database-strategy, so the cookie value IS the session token, and
//      anyone who can reach the screen over its hotspot is that operator.
//      -> no cookie reads anywhere in a device route
//   2. The credential is coupled to a session, so the device breaks when someone
//      logs out. Screens outlive staff accounts.
//      -> deviceAuth reads only the Authorization header
//   3. A device request resolves to a User row. Then it appears in
//      StreamSession, in stats, in activity logs — attribution drift nobody
//      notices for six months.
//      -> no session resolution, no userId written
//   4. A device request is relayed through an operator's browser. The relay
//      carries the cookie, so the device's request IS the operator's request.
//      -> no device route imports the presence or activity notifiers
//   5. An admin provisions a screen and that admin's session is reused for its
//      requests. -> createdById is audit-only and never gates anything.
//
// Run: npm run check:device-isolation
import fs from "node:fs";
import path from "node:path";
import { scrub, walkTs } from "./lib/tsx-scan.mts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

/** The code a device request is allowed to be made of. */
const DEVICE_ROUTES = path.join(process.cwd(), "app", "api", "devices");
const DEVICE_HELPERS = ["lib/device-auth.ts", "lib/device-service.ts"];

/**
 * Comments out, string literals left intact.
 *
 * The shared scrub() also blanks string BODIES, which is right for identifier
 * bans and wrong for the two bans below: `req.headers.get('cookie')` scrubs down
 * to `req.headers.get("")` and would sail straight past a literal-aware check.
 * So identifier bans run against scrub() and literal bans run against this.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");

const files: { label: string; scrubbed: string; literal: string }[] = [];
if (fs.existsSync(DEVICE_ROUTES)) {
  for (const f of walkTs(DEVICE_ROUTES)) {
    const raw = fs.readFileSync(f, "utf8");
    files.push({ label: path.relative(process.cwd(), f), scrubbed: scrub(raw), literal: stripComments(raw) });
  }
} else {
  // Not built yet. Say so rather than passing vacuously — a check that silently
  // matched nothing is worse than no check (scripts/check-privacy-boundaries.mts).
  console.log("  note  app/api/devices does not exist yet — route isolation is asserted once it does.");
}
for (const rel of DEVICE_HELPERS) {
  const p = path.join(process.cwd(), rel);
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    files.push({ label: rel, scrubbed: scrub(raw), literal: stripComments(raw) });
  }
}

// ---- 1. no session resolution anywhere ----
const SESSION_BANS: [string, RegExp][] = [
  ["getServerSession", /\bgetServerSession\b/],
  ["useSession", /\buseSession\b/],
  ["getToken", /\bgetToken\b/],
  ["sessionTokenFromCookies", /\bsessionTokenFromCookies\b/],
  ["cachedSession", /\bcachedSession\b/],
  ["authOptions", /\bauthOptions\b/],
];
for (const f of files) {
  for (const [what, re] of SESSION_BANS) {
    ok(!re.test(f.scrubbed), `${f.label} never resolves a session (${what})`);
  }
}

// ---- 2. no cookie is ever read ----
// The bare word, on literals intact, so every form is caught at once rather than
// one regex per spelling.
const COOKIE_BANS: [string, RegExp][] = [
  ["the word 'cookie' anywhere", /\bcookies?\b/i],
  ["NextRequest.cookies", /\.cookies\b/],
];
for (const f of files) {
  for (const [what, re] of COOKIE_BANS) {
    ok(!re.test(f.literal), `${f.label} never reads a cookie (${what})`);
  }
}

// ---- 3. nothing writes a userId ----
for (const f of files) {
  ok(!/\buserId\b/.test(f.scrubbed), `${f.label} never references userId`);
}

// ---- 4. the presence WRITERS are unreachable ----
// Reads are a different question from writes, and conflating them makes this
// check useless rather than strict. A wall display that SHOWS the signed-in
// count has to read the presence map, and it must not: a screen showing a wrong
// number would be embarrassing, whereas a screen that added itself to the map
// would make the station's own published figures wrong and nobody could say why.
//
// So the writers are banned outright, and the two readers are permitted only in a
// named place with a reason. The count a screen displays is read in
// lib/device-service.ts and nowhere else.
const PRESENCE_WRITERS: [string, RegExp][] = [
  ["notePresence", /\bnotePresence\b/],
  ["noteStreamStart", /\bnoteStreamStart\b/],
  ["noteStreamEnd", /\bnoteStreamEnd\b/],
  ["noteActivity", /\bnoteActivity\b/],
];
const PRESENCE_READERS: [string, RegExp][] = [
  ["freshPresence", /\bfreshPresence\b/],
  ["liveStreams", /\bliveStreams\b/],
];

/** Files permitted to READ presence, and why. One line each, on purpose. */
const PRESENCE_READERS_ALLOWED: Record<string, string> = {
  "lib/device-service.ts": "reads the count for display; never writes, and this is the only device file that may",
};

for (const f of files) {
  for (const [what, re] of PRESENCE_WRITERS) {
    ok(!re.test(f.scrubbed), `${f.label} never writes to presence (${what})`);
  }
  for (const [what, re] of PRESENCE_READERS) {
    const allowed = PRESENCE_READERS_ALLOWED[f.label];
    ok(!re.test(f.scrubbed) || Boolean(allowed), `${f.label} ${allowed ? `may read presence (${what})` : `never reads presence (${what})`}`);
  }
}
// And the allowlist itself cannot rot into a blank cheque.
for (const [file, why] of Object.entries(PRESENCE_READERS_ALLOWED)) {
  ok(why.length > 20, `${file}'s presence-read allowance states a reason`);
  ok(files.some((f) => f.label === file), `${file} in the presence-read allowance still exists`);
}

// ---- 5. deviceAuth reads one input and no more ----
{
  const auth = path.join(process.cwd(), "lib", "device-auth.ts");
  if (fs.existsSync(auth)) {
    const raw = fs.readFileSync(auth, "utf8");
    const src = scrub(raw);
    // Against the RAW source: scrub blanks string bodies, so looking for the
    // word "authorization" in scrubbed text finds nothing at all.
    ok(/headers\s*\.\s*get\s*\(\s*["'`]authorization/i.test(raw), "device-auth reads the Authorization header");
    // The whole point: one credential, and it is not a session.
    ok(!/cookie/i.test(src), "device-auth never mentions a cookie at all");
    ok(!/getServerSession|cachedSession|authOptions/.test(src), "device-auth has no session fallback path");
    ok(/hashToken/.test(src), "device-auth hashes before it stores");
    ok(!/token\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/.test(src), "device-auth contains no hardcoded token");
    ok(/prevTokenExpires/.test(src), "device-auth implements the rotation grace window");
    ok(/CLAIM_TOKEN_DAYS/.test(src), "claim tokens have an explicit lifetime, not a magic number");
  }
}

// ---- 6. audit fields are audit-only ----
{
  const schema = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const device = /model Device \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  ok(/createdById\s+String\?/.test(device), "Device.createdById is optional");
  ok(/onDelete:\s*SetNull/.test(device), "Device audit relations are SetNull, not Cascade");
  ok(!/onDelete:\s*Cascade/.test(device), "nothing on Device cascades a delete");
  for (const f of files) {
    // allowed to WRITE them, never to branch on them
    const branches = f.scrubbed.split("\n").filter((l) => /createdById|uploadedById/.test(l));
    for (const line of branches) {
      ok(
        !/\b(if|where|&&|\|\||===|!==)\b.*(createdById|uploadedById)/.test(line),
        `${f.label} never makes a decision using an audit field`,
        line.trim().slice(0, 70),
      );
    }
  }
}

// ---- the checker checks itself ----
// Each mutation below is a real drift from the table at the top of this file. If
// an assertion passes on one, this check cannot catch that class and is
// decoration rather than a gate.
{
  const mutations: [string, string, RegExp][] = [
    ["reads a session", "const s = await getServerSession(authOptions);", /\bgetServerSession\b/],
    ["reads a cookie", "const t = req.cookies.get('sessionToken');", /\.cookies\b/],
    ["writes presence", "notePresence(person, Date.now());", /\bnotePresence\b/],
    ["starts a stream session", "noteStreamStart(person);", /\bnoteStreamStart\b/],
    ["writes a userId", "data: { userId: 'x' }", /\buserId\b/],
  ];
  for (const [label, code, re] of mutations) {
    ok(re.test(code), `MUTATION CAUGHT: ${label} matches its ban`);
  }
  // A WRITE must fail even in the one file allowed to READ. Otherwise the
  // allowance quietly becomes a blank cheque and a screen could start marking
  // itself online from the service layer.
  ok(
    !PRESENCE_WRITERS.every(([, re]) => !re.test("notePresence(p);")),
    "MUTATION CAUGHT: a presence write trips the ban even in the file allowed to read",
  );
  const clean = "const digest = hashToken(raw); await prisma.device.findFirst({ where: { tokenHash: digest } });";
  const bans = SESSION_BANS.concat(COOKIE_BANS, PRESENCE_WRITERS, PRESENCE_READERS).map(([, re]) => re);
  ok(!bans.some((re) => re.test(clean)), "MUTATION CAUGHT: legitimate device code trips none of the bans");
  ok(!/\buserId\b/.test(clean), "MUTATION CAUGHT: legitimate device code never mentions userId");
}

console.log(`  ${passed}/${passed + failed} device-isolation assertions passed`);
if (failed > 0) process.exit(1);