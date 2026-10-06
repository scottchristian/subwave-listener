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
  for (const rel of ["approve", "revoke", "remove"]) {
    const f = path.join(repo, "app", "api", "admin", rel, "route.ts");
    ok(/dropSessionsForUser/.test(readFileSync(f, "utf8")), `${rel} drops that user's cached verdicts`);
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

console.log(`  ${passed}/${passed + failed} session-cache assertions passed`);
if (failed > 0) process.exit(1);
