// activeListeners decides whether deploy.sh refuses to run. A false positive
// blocks every deploy; a false negative cuts listeners off mid-song. So the
// interesting cases are the ones that are easy to get wrong:
//
//   - Safari opens a second StreamSession row per Play press, so rows must be
//     deduped by user or one listener is named twice
//   - a session that ended is not a listener
//   - a session that started long ago and never ended is not a listener
//   - a listener with no resolvable name still has to appear, because the
//     operator needs to know to wait for them
//
// Runs against a throwaway sqlite database built from the repo schema, so the
// window and dedupe run through the same query the deploy gate uses.
//
// Run: npm run check:listeners
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();
const saved = { ...process.env };

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-listeners-"));
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
const hash = crypto.createHash("sha256").update(schema).digest("hex");
const hashFile = path.join(clientDir, "schema.sha256");
if ((await fs.readFile(hashFile, "utf8").catch(() => "")) !== hash) {
  await fs.rm(clientDir, { recursive: true, force: true });
  await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], { cwd: REPO, timeout: 180000 });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(hashFile, hash);
}
process.env.DATABASE_URL = `file:${path.join(tmp, "main.db")}`;
process.env.DB_PROVIDER = "sqlite";
process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY?.trim() || "a".repeat(64);
await run(path.join(REPO, "node_modules", ".bin", "prisma"),
  ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
  { cwd: REPO, timeout: 120000, env: process.env });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
const { activeListeners } = await import("../lib/listeners.ts");
const { enc, idx } = await import("../lib/pii.ts");

const MINUTE = 60 * 1000;
const now = Date.now();

// A listener who is streaming right now, with an encrypted display name.
const alice = await db.user.create({
  data: { email: idx("alice@example.com")!, emailEnc: enc("alice@example.com"), name: enc("Alice"), isApproved: true },
});
// A listener with no resolvable name at all — the operator still must see them.
const anon = await db.user.create({
  data: { email: idx("anon@example.com")!, isApproved: true },
});

const open = (userId: string, agoMs: number, endTime: Date | null = null) =>
  db.streamSession.create({ data: { userId, startTime: new Date(now - agoMs), endTime } });

await open(alice.id, 2 * MINUTE);
await open(alice.id, 1 * MINUTE); // Safari's second row for the same Play press
await open(anon.id, 30 * 1000);

{
  const list = await activeListeners();
  ok(list.length === 2, `two people are listening, not three rows (got ${list.length})`);
  const ids = list.map((l) => l.userId).sort();
  ok(ids[0] === alice.id && ids[1] === anon.id, "both listeners are named, and neither is missing");
  ok(new Set(list.map((l) => l.userId)).size === list.length, "no listener appears twice");
  const aliceRow = list.find((l) => l.userId === alice.id)!;
  ok(aliceRow.name === "Alice", "an encrypted name is decrypted for the gate");
  ok(aliceRow.since !== "" && !Number.isNaN(Date.parse(aliceRow.since)), "since is a parseable timestamp");
}

// Ordered oldest-first, so the operator reads them in arrival order.
{
  const list = await activeListeners();
  ok(Date.parse(list[0].since) <= Date.parse(list[1].since), "listeners are ordered oldest first");
}

// A user with no name still appears, labelled rather than dropped.
{
  const anonRow = (await activeListeners()).find((l) => l.userId === anon.id)!;
  ok(anonRow.name === "unnamed listener", "a nameless listener is labelled, not omitted");
}

// A session that ended is nobody listening any more. Her earlier open rows are
// cleared first, so this asserts on the ended row alone.
await db.streamSession.deleteMany({ where: { userId: alice.id } });
await db.streamSession.create({ data: { userId: alice.id, startTime: new Date(now - 3 * MINUTE), endTime: new Date(now - MINUTE) } });
{
  const list = await activeListeners();
  ok(!list.some((l) => l.userId === alice.id), "an ended session is not a listener");
}

// An open session that started over the window ago is a stale row, not a listener.
const stale = await db.user.create({ data: { email: idx("stale@example.com")!, name: enc("Stale"), isApproved: true } });
await open(stale.id, 11 * MINUTE);
{
  const list = await activeListeners();
  ok(!list.some((l) => l.userId === stale.id), "a session older than the window is not a listener");
}

// And the gate is empty when nobody is there — the case that must not block a deploy.
await db.streamSession.deleteMany({});
{
  const list = await activeListeners();
  ok(list.length === 0, "an idle station lists nobody, so deploys are not blocked");
}

await db.$disconnect();
console.log(`  ${passed}/${passed + failed} listeners assertions passed`);
await cleanup();
Object.assign(process.env, saved);
process.exit(failed > 0 ? 1 : 0);
