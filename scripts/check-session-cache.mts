// Session cache: hot routes answer from memory with bounded staleness.
// Loader and clock are injected — no database. Run:
// node scripts/check-session-cache.mts (wired as `npm run check:session-cache`).
import { cachedSession, clearSessionCache, type CachedSession, refreshSessionsForUser } from "../lib/session-cache.ts";

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
  canUseDj: false,
  canApprove: false,
  canUseSkills: false,
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

// ---- structural guards on the security properties ----
// These are properties of the code's shape, not of its behaviour at runtime, so
// they are asserted against the source. Each one exists because the failure is
// invisible: a stale admin right is correct code that is simply out of date.
{
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const repo = process.cwd();

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const adminRoutes = walk(path.join(repo, "app", "api", "admin")).filter((f) => f.endsWith("route.ts"));
  ok(adminRoutes.length > 0, "the admin routes were found to check");

  // The one that matters most: a cached verdict must never gate an admin route.
  // Admin-only routes verify live so a privilege change lands immediately.
  const cachedInAdmin = adminRoutes.filter((f) => /cachedSession/.test(readFileSync(f, "utf8")));
  ok(
    cachedInAdmin.length === 0,
    `no admin route reads the cached session (found in ${cachedInAdmin.map((f) => path.relative(repo, f)).join(", ") || "none"})`
  );
  const liveInAdmin = adminRoutes.filter((f) => /getServerSession/.test(readFileSync(f, "utf8")));
  ok(liveInAdmin.length === adminRoutes.length, "every admin route verifies the session live instead");

  // Every path that changes approval or removes an account must drop the cached
  // verdicts, or a revoked listener keeps their access until the interval ends.
  // Approve and revoke must WRITE the new permissions through, not merely drop
  // the entry: a drop is correct but spends a database read on the next request,
  // which is the read this cache exists to avoid.
  for (const rel of ["approve", "revoke", "user-perms"]) {
    const f = path.join(repo, "app", "api", "admin", rel, "route.ts");
    ok(/refreshSessionsForUser\(/.test(readFileSync(f, "utf8")), `${rel} writes the new permissions through`);
    ok(!/dropSessionsForUser\(/.test(readFileSync(f, "utf8")), `${rel} does not merely drop the entry`);
  }
  // Removal is the opposite case: the user is gone, so there is nothing to write
  // to and a stale verdict must not survive them.
  {
    const f = path.join(repo, "app", "api", "admin", "remove", "route.ts");
    ok(/dropSessionsForUser\(/.test(readFileSync(f, "utf8")), "remove drops the deleted user's cached verdicts");
    ok(!/refreshSessionsForUser\(/.test(readFileSync(f, "utf8")), "and does not try to write permissions to a deleted user");
  }

  // Signing out must drop the token's verdict, or the cache outlives the session.
  const auth = readFileSync(path.join(repo, "app", "api", "auth", "[...nextauth]", "route.ts"), "utf8");
  ok(/async signOut\(\s*\{/.test(auth), "a sign-out event is handled");
  ok(/dropSessionCache\(/.test(auth), "and it drops the cached verdict");

  // The session callback is handed the user row by the adapter. Re-reading it
  // is the single largest avoidable query on an authenticated request, so its
  // return is pinned rather than left to a code review to notice.
  const callback = auth.slice(auth.indexOf("async session("), auth.indexOf("events:"));
  ok(!/prisma\.\w+\.(findUnique|findFirst)/.test(callback), "the session callback runs no query of its own");
  ok(!/await\s+prisma/.test(callback), "and awaits no database work at all");
}

// ---- the memory tier of a permission write-through ----
// The point of writing the new values rather than dropping the entry: the very
// next request gets them, and gets them without a database read.
{
  clearSessionCache();
  loads = 0;
  await cachedSession("tok-r", { now: T0, load });

  refreshSessionsForUser("u1", { isApproved: false });
  const afterRevoke = await cachedSession("tok-r", { now: T0 + 1000, load });
  ok(afterRevoke?.isApproved === false, "a revoked user is unapproved on the next read");
  ok(loads === 1, "and it cost no further load — the write-through answered it");

  refreshSessionsForUser("u1", { isApproved: true });
  ok((await cachedSession("tok-r", { now: T0 + 2000, load }))?.isApproved === true, "re-approving lands just as fast");
  ok(loads === 1, "still with no extra load");

  // Only the named flags move. Clearing isAdmin must not clear canUseDj — start
  // from an entry that actually has it set, or the assertion proves nothing.
  clearSessionCache();
  await cachedSession("tok-p", {
    now: T0,
    load: async () => ({ ...base, isAdmin: true, canUseDj: true }),
  });
  refreshSessionsForUser("u1", { isAdmin: false });
  const partial = await cachedSession("tok-p", { now: T0 + 3000, load });
  ok(partial?.isAdmin === false, "isAdmin is cleared");
  ok(partial?.canUseDj === true, "an unnamed flag keeps its value, not reset to false");
  ok(partial?.isApproved === true, "and so does approval");

  // Every token the user holds changes, since they may be on several devices.
  // tok-r is re-primed first: the block above cleared the cache to test a
  // partial write, so it is no longer held.
  await cachedSession("tok-r", { now: T0, load });
  await cachedSession("tok-r2", { now: T0, load: async () => ({ ...base, userId: "u1" }) });
  refreshSessionsForUser("u1", { isApproved: false });
  ok((await cachedSession("tok-r", { now: T0 + 4000, load }))?.isApproved === false, "the first token changed");
  ok((await cachedSession("tok-r2", { now: T0 + 4000, load }))?.isApproved === false, "and so did the second");

  // And nobody else is affected.
  await cachedSession("tok-other", { now: T0, load: async () => ({ ...base, userId: "u2" }) });
  refreshSessionsForUser("u1", { isApproved: true });
  ok((await cachedSession("tok-other", { now: T0 + 5000, load }))?.isApproved === true, "another user's entry is untouched by name");
  clearSessionCache();
  await cachedSession("tok-other", { now: T0, load: async () => ({ ...base, userId: "u2", isApproved: false }) });
  refreshSessionsForUser("u1", { isApproved: true });
  ok((await cachedSession("tok-other", { now: T0 + 5000, load }))?.isApproved === false, "and a write for u1 leaves u2 alone");

  // Nothing to do is not an error.
  refreshSessionsForUser("u1", {});
  refreshSessionsForUser("", { isApproved: true });
  ok(true, "an empty flag set or empty user id is simply ignored");
}

console.log(`  ${passed}/${passed + failed} session-cache assertions passed`);
if (failed > 0) process.exit(1);
