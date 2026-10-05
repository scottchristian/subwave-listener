// Session cache: hot routes answer from memory with bounded staleness.
// Loader and clock are injected — no database. Run:
// node scripts/check-session-cache.mts (wired as `npm run check:session-cache`).
import { cachedSession, clearSessionCache, type CachedSession } from "../lib/session-cache.ts";

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
let loads = 0;
const base: CachedSession = {
  userId: "u1",
  sessionExpires: T0 + 3600_000,
  isApproved: true,
  isAdmin: false,
  name: "Fan",
  nickname: null,
  email: null,
  emailEnc: null,
};
const load = async () => {
  loads++;
  return { ...base };
};

clearSessionCache();
ok((await cachedSession(undefined, { now: T0, load })) === null, "no token -> null, no load");
ok(loads === 0, "no token loads nothing");

ok((await cachedSession("t1", { now: T0, load }))?.userId === "u1", "miss loads");
ok(loads === 1, "one load for the miss");
ok((await cachedSession("t1", { now: T0 + 30_000, load }))?.userId === "u1", "hit inside TTL");
ok(loads === 1, "hit loads nothing");

// Session TTL out, approval fresh: full reload.
ok((await cachedSession("t1", { now: T0 + 61_000, load }))?.userId === "u1", "reload past session TTL");
ok(loads === 2, "reload loads once");

// Revocation lands: loader now says gone.
const gone = async () => {
  loads++;
  return null;
};
ok((await cachedSession("t1", { now: T0 + 122_000, load: gone })) === null, "revoked session -> null");

// Approval flip inside session TTL refreshes approval only.
clearSessionCache();
loads = 0;
await cachedSession("t2", { now: T0, load });
const demoted = async () => {
  loads++;
  return { ...base, isApproved: false };
};
// 4 min: session fresh, approval stale -> approval refresh path.
ok((await cachedSession("t2", { now: T0 + 4 * 60_000, load: demoted }))?.isApproved === false, "demotion lands via approval refresh");
ok(loads === 2, "approval refresh loads once");

// Expired sessions never pass, even cached.
clearSessionCache();
const expired = async () => ({
  ...base,
  sessionExpires: T0 - 1000,
});
ok((await cachedSession("t3", { now: T0, load: expired })) === null, "expired session -> null");

console.log(`  ${passed}/${passed + failed} session-cache assertions passed`);
if (failed > 0) process.exit(1);
