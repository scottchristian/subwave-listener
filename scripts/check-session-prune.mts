// The orphan sweep for StreamSession.
//
// The whole safety argument is one sentence: this must delete rows that are
// already worthless and never touch a session that might still be real. So the
// suite is built around what must SURVIVE, not just what goes — a live session,
// a young orphan, a closed session, and a session that merely started before
// the cutoff.
//
// Every case runs against a throwaway sqlite database built from the repo
// schema, so the query is the same one that will run in production.
//
// Run: npm run check:session-prune  (part of `npm run check:db`)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();
const savedEnv = { ...process.env };

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-prune-"));
const clientDir = path.join(REPO, ".test-client");
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");
const cleanup = async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fs.rm(schemaPath, { force: true }).catch(() => {});
};
process.on("exit", () => { void cleanup(); });

await run("node", [path.join(REPO, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
let schema = await fs.readFile(schemaPath, "utf8");
schema = schema.replace(
  /generator client \{[\s\S]*?\}/,
  `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
);
await fs.writeFile(schemaPath, schema);
const hash = createHash("sha256").update(schema).digest("hex");
const hashFile = path.join(clientDir, "schema.sha256");
if ((await fs.readFile(hashFile, "utf8").catch(() => "")) !== hash) {
  await fs.rm(clientDir, { recursive: true, force: true });
  await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], { cwd: REPO, timeout: 180000 });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(hashFile, hash);
}
process.env.DATABASE_URL = `file:${path.join(tmp, "main.db")}`;
process.env.DB_PROVIDER = "sqlite";
await run(path.join(REPO, "node_modules", ".bin", "prisma"),
  ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
  { cwd: REPO, timeout: 120000, env: process.env });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
(globalThis as any).prisma = db;

const prune = await import("../lib/session-prune.ts");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const alice = await db.user.create({ data: { email: "prune-alice@example.com", isApproved: true } });
const bob = await db.user.create({ data: { email: "prune-bob@example.com", isApproved: true } });

/** A row, open by default (endTime null = the orphan shape). */
const row = (userId: string, startedAgoMs: number, endTime: Date | null = null) =>
  db.streamSession.create({
    data: { userId, startTime: new Date(NOW - startedAgoMs), endTime },
  });

// ---- the population, chosen so each group proves something different ----
const orphanOld = await row(alice.id, 30 * DAY);      // 30 days unclosed: reaped
const orphanOlder = await row(alice.id, 90 * DAY);    // 90 days unclosed: reaped
const orphanEdge = await row(bob.id, 25 * HOUR);      // 25h: reaped, over a day
const orphanYoung = await row(bob.id, 6 * HOUR);      // 6h: kept, under a day
const orphanNow = await row(bob.id, 60_000);          // just started: kept
const closedOld = await row(alice.id, 40 * DAY, new Date(NOW - 40 * DAY + 600_000)); // closed: kept
const closedRecent = await row(bob.id, 2 * DAY, new Date(NOW - 2 * DAY + 60_000));  // closed: kept
// A long listen on a flaky connection that never closed. The sweep must NOT
// invent an endTime for it — but after a day it is indistinguishable from an
// orphan, so this asserts the honest behaviour: gone, not silently closed.
const longBroken = await row(alice.id, 26 * HOUR);

const all = [orphanOld, orphanOlder, orphanEdge, orphanYoung, orphanNow, closedOld, closedRecent, longBroken];
const alive = async () => new Set((await db.streamSession.findMany({ select: { id: true } })).map((r) => r.id));

// ---- a dry run counts without removing ----
{
  const before = await alive();
  const dry = await prune.pruneOrphanStreamSessions({ now: NOW, dryRun: true });
  ok(dry.ok, "the dry run succeeds");
  ok(dry.matched === 4, `a dry run counts the four orphans (got ${dry.matched})`);
  ok(dry.removed === 0, "and removes nothing");
  ok((await alive()).size === before.size, "the table is untouched");
}

// ---- the sweep ----
{
  const res = await prune.pruneOrphanStreamSessions({ now: NOW });
  ok(res.ok, "the sweep succeeds");
  ok(res.matched === 4 && res.removed === 4, `it removes exactly the orphans (got ${res.removed})`);

  const left = await alive();
  ok(!left.has(orphanOld.id), "a 30-day orphan is gone");
  ok(!left.has(orphanOlder.id), "a 90-day orphan is gone");
  ok(!left.has(orphanEdge.id), "a 25-hour orphan is gone");
  ok(!left.has(longBroken.id), "an unclosed long listen is removed, not given a fake endTime");

  ok(left.has(orphanYoung.id), "a 6-hour orphan SURVIVES");
  ok(left.has(orphanNow.id), "a session that just started SURVIVES");
  ok(left.has(closedOld.id), "a closed session from last month SURVIVES");
  ok(left.has(closedRecent.id), "a recently closed session SURVIVES");
  ok(left.size === 4, `only the four keepers remain (got ${left.size})`);

  // Nothing invented: no closed row may gain an endTime it did not have.
  const closedStill = await db.streamSession.findUnique({ where: { id: closedOld.id } });
  ok(closedStill?.endTime?.getTime() === closedOld.endTime?.getTime(), "a closed session keeps its original endTime");
}

// ---- idempotent: a second sweep has nothing to do ----
{
  const again = await prune.pruneOrphanStreamSessions({ now: NOW });
  ok(again.ok && again.matched === 0 && again.removed === 0, "a second sweep over a clean table removes nothing");
}

// ---- time advances, so yesterday's survivors become eligible ----
{
  const later = await prune.pruneOrphanStreamSessions({ now: NOW + 25 * HOUR });
  ok(later.removed === 2, `a day later the two young orphans are reaped (got ${later.removed})`);
  const left = await alive();
  ok(left.size === 2, `only the two closed sessions remain (got ${left.size})`);
}

// ---- the cutoff boundary: strictly "older than" ----
{
  const user = await db.user.create({ data: { email: "prune-edge@example.com", isApproved: true } });
  const exactlyAt = await row(user.id, 24 * HOUR);          // startTime === cutoff
  const justOlder = await row(user.id, 24 * HOUR + 60_000); // one minute past it
  const justInside = await row(user.id, 24 * HOUR - 60_000);
  const res = await prune.pruneOrphanStreamSessions({ now: NOW });
  const left = await alive();
  ok(res.ok, "the boundary sweep succeeds");
  ok(left.has(exactlyAt.id), "a row starting exactly AT the cutoff survives (the comparison is lt, not lte)");
  ok(!left.has(justOlder.id), "a row one minute past the cutoff is reaped");
  ok(left.has(justInside.id), "a row one minute inside the window survives");
}

// ---- a custom age is honoured ----
{
  // Cleared first: with an age of one hour, every leftover row from earlier
  // cases is also older than an hour, so the count would be meaningless.
  await db.streamSession.deleteMany({});
  const user = await db.user.create({ data: { email: "prune-custom@example.com", isApproved: true } });
  const threeHours = await row(user.id, 3 * HOUR);
  const oneHourOld = await row(user.id, 61 * 60_000);
  const justInside = await row(user.id, 30 * 60_000);
  const closedButOld = await row(user.id, 5 * DAY, new Date(NOW - 5 * DAY + 1000));
  const res = await prune.pruneOrphanStreamSessions({ now: NOW, minAgeMs: HOUR });
  ok(res.removed === 2, `an age of one hour reaps only the two orphans past it (got ${res.removed})`);
  const left = await alive();
  ok(!left.has(threeHours.id), "the 3-hour orphan is gone");
  ok(!left.has(oneHourOld.id), "the 61-minute orphan is gone");
  ok(left.has(justInside.id), "a 30-minute-old session SURVIVES");
  ok(left.has(closedButOld.id), "a closed session SURVIVES at any age");
}

// ---- the default is conservative, and matches what the stats route ignores ----
{
  ok(prune.ORPHAN_MIN_AGE_MS === 24 * 3_600_000, "the default age is a day");
  ok(prune.PRUNE_INTERVAL_MS === 12 * 3_600_000, "the sweep runs twice a day, well inside the sleep window");
  ok(
    prune.ORPHAN_MIN_AGE_MS > 3_600_000,
    "the default is more conservative than the hour the stats route already ignores"
  );
  // Twice a day plus a boot sweep must not become a heartbeat that keeps the
  // database awake, which is the whole reason any of this exists.
  ok(prune.PRUNE_INTERVAL_MS > 15 * 60_000, "the interval is far longer than the free tier's idle window");
}

// ---- an unusable database is a skipped job, not a crash ----
{
  // Repointing DATABASE_URL cannot test this: the module's client was bound at
  // import, so it would sail straight on. Taking the table away makes the very
  // query the sweep runs genuinely fail.
  await db.$executeRawUnsafe("DROP TABLE \"StreamSession\"");
  let threw = "";
  let res: any = null;
  try {
    res = await prune.pruneOrphanStreamSessions({ now: NOW });
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", `a failing sweep does not throw${threw ? " — " + threw : ""}`);
  ok(res?.ok === false, "and reports failure");
  ok(res?.removed === 0, "and removes nothing");
  ok(res?.matched === 0, "and claims no matches");
}

// ---- structural: the sweep must not run on a timer at import time ----
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/session-prune.ts", import.meta.url), "utf8");
  ok(!/setInterval\(/.test(src), "no setInterval, so a stray interval cannot hold the event loop open");
  ok(/startSessionPruneScheduler/.test(src), "the scheduler is exported for the boot hook");
  ok(/resetPruneScheduler/.test(src), "and can be reset by tests");
}

await db.$disconnect();
console.log(`  ${passed}/${passed + failed} session-prune assertions passed`);
await cleanup();
Object.assign(process.env, savedEnv);
process.exit(failed > 0 ? 1 : 0);
