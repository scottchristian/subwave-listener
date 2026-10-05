// Live presence: who is here and streaming, from memory. Clock driven by
// hand, no database. Run: node scripts/check-presence-live.mts
// (wired as `npm run check:presence-live`).
import {
  notePresence,
  noteStreamStart,
  noteStreamEnd,
  freshPresence,
  liveStreams,
  toLivePerson,
  PRESENCE_WINDOW_MS,
} from "../lib/presence-live.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const T0 = 1_800_000_000_000;
ok(PRESENCE_WINDOW_MS === 2 * 60 * 1000, "2-minute freshness rule");

const sam = toLivePerson({ id: "u1", name: "Sam", nickname: null, email: null, emailEnc: null });
const rita = toLivePerson({ id: "u2", name: "Rita", nickname: "Rit", email: null, emailEnc: null });
ok(sam.userId === "u1" && rita.nickname === "Rit", "person carries display fields");

// Empty room.
ok(freshPresence(T0).length === 0, "no stamps -> nobody here");
ok(liveStreams(T0).length === 0, "no streams -> nothing streaming");

// Heartbeats show up newest-first...
notePresence(sam, T0);
notePresence(rita, T0 + 1000);
let fresh = freshPresence(T0 + 2000);
ok(fresh.length === 2 && fresh[0].userId === "u2", "two here, newest first");

// ...and age out past the window.
ok(freshPresence(T0 + 121 * 1000).length === 0, "stale stamps swept");
notePresence(sam, T0 + 121 * 1000);
ok(freshPresence(T0 + 122 * 1000).length === 1, "re-stamp after silence works");

// Streams: keyed by user, oldest first, explicit end wins.
noteStreamStart(sam, T0);
noteStreamStart(sam, T0 + 5000); // Safari double-open: still one entry
noteStreamStart(rita, T0 + 9000);
let live = liveStreams(T0 + 10000);
ok(live.length === 2 && live[0].userId === "u1", "deduped by user, oldest first");
noteStreamEnd("u1");
live = liveStreams(T0 + 11000);
ok(live.length === 1 && live[0].userId === "u2", "ended stream leaves the map");
// Ancient opens do not linger forever.
ok(liveStreams(T0 + 11 * 60 * 1000).length === 0, "10-minute stream cap sweeps orphans");

console.log(`  ${passed}/${passed + failed} presence-live assertions passed`);
if (failed > 0) process.exit(1);
