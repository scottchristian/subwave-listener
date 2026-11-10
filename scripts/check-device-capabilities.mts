// What a wall screen is allowed to show, and what it can never touch.
//
// THREE EXCLUSIONS, AND THEY REST ON DIFFERENT FOUNDATIONS — which is the whole
// reason they are listed separately rather than as one "permissions" list:
//
//   1. BELONGS TO A PERSON. Likes, liked songs, requests. A binding problem, not
//      a permission one: those rows need a userId, a screen has none, and minting
//      a fake user is the exact thing device/capabilities.md forbids.
//   2. LEAVES THE ROOM. Spotify and Apple links, share, install. A PRODUCT
//      decision — note that app/page.tsx:2590 shows those links to signed-out
//      listeners today, so excluding them from a screen is a choice, not
//      mirroring. A wall has no business sending anyone to another app.
//   3. PRIVILEGED. Never play, DJ say, on-air controls. An authorisation
//      boundary that cannot move, because admin permissions on PROVISIONING are
//      separate from what the provisioned thing may do.
//
// 1 and 2 could change without touching auth. 3 could not.
//
// THE PRINCIPLE UNDER ALL THREE: nothing on a screen refers to a person. No
// "your", no account, no per-listener state. If a stranger in a hallway taps
// Skip, the screen cannot surface anything about them, because there is nothing
// about them to surface. A display people touch that learns nothing about who
// touched it.
//
// Run: npm run check:device-capabilities
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

const DEVICE = path.join(process.cwd(), "app", "api", "devices");
const SERVICE = path.join(process.cwd(), "lib", "device-service.ts");
const TYPES = path.join(process.cwd(), "lib", "device-types.ts");

const files = walkTs(DEVICE).map((f) => ({
  label: path.relative(process.cwd(), f),
  scrubbed: scrub(fs.readFileSync(f, "utf8")),
  literal: fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, ""),
}));
for (const p of [SERVICE, TYPES]) {
  const raw = fs.readFileSync(p, "utf8");
  files.push({ label: path.relative(process.cwd(), p), scrubbed: scrub(raw), literal: raw });
}

// ---- 1. belongs to a person: nothing account-shaped is written ----
const ACCOUNT_BANS: [string, RegExp][] = [
  ["a SongLike write", /\b(songLike|prisma\.songLike)\b/],
  ["a SongRequest write", /\b(songRequest|prisma\.songRequest)\b/],
  ["a StreamSession write", /\b(streamSession|prisma\.streamSession)\b/],
  ["any user lookup", /\bprisma\.user\b/],
];
for (const f of files) {
  for (const [what, re] of ACCOUNT_BANS) {
    ok(!re.test(f.scrubbed), `${f.label} never writes ${what}`);
  }
}

// ---- 2. leaves the room: no outbound links anywhere in the payload ----
const LINK_BANS: [string, RegExp][] = [
  ["spotifyUrl", /spotifyUrl/i],
  ["appleMusicUrl", /appleMusicUrl/i],
  ["open.spotify.com", /open\.spotify\.com/i],
  ["a generic link field", /\blinkUrl\b|\blinkHref\b/i],
];
for (const f of files) {
  for (const [what, re] of LINK_BANS) {
    ok(!re.test(f.scrubbed), `${f.label} never carries ${what}`);
  }
}

// ---- 3. privileged: admin affordances are unreachable ----
const ADMIN_BANS: [string, RegExp][] = [
  ["never-play", /never-?play|blockTrack|blockTrackId/i],
  ["DJ say", /djSay|dj\/say/i],
  // Scoped to the admin toggle specifically. `onAirForSec` is a countdown of how
  // long the current voice has been on air — a field the screen is meant to show,
  // and nothing to do with taking the station off air.
  ["an on-air toggle", /toggleOnAir|onAir\s*[:=]|postOnAir|\/on-?air\b/i],
];
for (const f of files) {
  // The SKIP route is the one place station credentials are correct — it is
  // forwarding to the backend on the station's behalf, not acting as an admin.
  if (f.label.endsWith("devices/skip/route.ts")) continue;
  for (const [what, re] of ADMIN_BANS) {
    ok(!re.test(f.scrubbed), `${f.label} never offers ${what}`);
  }
}

// ---- no first person, anywhere in the contract ----
{
  const src = fs.readFileSync(TYPES, "utf8");
  ok(!/\byour\b/i.test(src.replace(/\/\/.*$/gm, "")), "the payload contract has no 'your' in any field name");
  ok(!/nickname/i.test(src), "the payload contract carries no nickname");
  ok(!/hideLikeName/i.test(src), "the payload contract carries no per-listener preference");
}

// ---- the declared type has no room for any of it ----
{
  // Scrubbed: field SHAPES are what matter here, and a doc comment explaining
  // that onAirForSec comes from the backend's session object is not a field.
  const src = scrub(fs.readFileSync(TYPES, "utf8"));
  const state = /export interface DeviceState \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  ok(state.length > 0, "DeviceState is declared in device-types.ts");
  for (const [what, re] of ([
    ...LINK_BANS,
    ["a userId", /\buserId\b/],
    ["a session object", /session/i],
  ] as [string, RegExp][])) {
    ok(!re.test(state), `DeviceState has no ${what} field`);
  }
  // signedIn is a COUNT, and counts are the one thing a screen may show about
  // people — so its presence is asserted rather than merely tolerated.
  ok(/signedIn:\s*number/.test(state), "DeviceState carries the signed-in COUNT, read-only");
  ok(!/nickname|hideLikeName|likedTracks/i.test(state), "DeviceState carries no per-listener identity or preference");
}

// ---- the checker checks itself ----
{
  const mutations: [string, string, RegExp][] = [
    ["a link in the payload", "spotify: 'https://open.spotify.com/track/x'", /open\.spotify\.com/i],
    ["a like being written", "await prisma.songLike.create({ data: {} })", /\bprisma\.songLike\b/],
    ["a request being written", "await prisma.songRequest.create({ data: {} })", /\bprisma\.songRequest\b/],
    ["never-play surfacing", "if (action === 'blockTrack') {}", /blockTrack/i],
    ["DJ say surfacing", "await fetch(cfg.apiUrl + '/dj/say')", /dj\/say/i],
  ];
  for (const [label, code, re] of mutations) {
    ok(re.test(code), `MUTATION CAUGHT: ${label} matches its ban`);
  }
  const clean = `return NextResponse.json({ counts: { signedIn: 12, listening: 3 } });`;
  ok(
    !LINK_BANS.concat(ACCOUNT_BANS).map(([, re]) => re).some((re) => re.test(clean)),
    "MUTATION CAUGHT: a legitimate state payload trips none of the bans",
  );
}

console.log(`  ${passed}/${passed + failed} device-capability assertions passed`);
if (failed > 0) process.exit(1);