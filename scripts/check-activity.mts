// Activity gate: anyoneActive() answers "is someone here?" for every
// background database loop, so an empty station stops polling.
//
// Hermetic like check-backup: throwaway sqlite client, temp database, nothing
// in the repo touched except prisma/.gen-test.prisma (removed on the way out).
//
// Run: TEST_PRISMA_CLIENT="$PWD/.test-client" node --import ./scripts/test-register.mjs scripts/check-activity.mts
// (wired as `npm run check:activity`).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.env.TEST_REPO_ROOT || process.cwd();

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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-activity-test-"));
const clientDir = path.join(REPO, ".test-client");
const hashFile = path.join(clientDir, "schema.sha256");
if (!process.env.TEST_PRISMA_CLIENT) {
  throw new Error("TEST_PRISMA_CLIENT is not set — run via `npm run check:activity`");
}
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");

async function cleanup() {
  try {
    process.chdir(REPO);
  } catch {}
  if (process.env.KEEP_TEST_DIR) {
    console.log(`  (keeping ${tmpRoot})`);
    return;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(schemaPath, { force: true }).catch(() => {});
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

try {
  // ---- Throwaway sqlite client (same hash gate as check-backup) ----
  await run("node", [path.join(REPO, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
  let schema = await fs.readFile(schemaPath, "utf8");
  schema = schema.replace(
    /generator client \{[\s\S]*?\}/,
    `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
  );
  await fs.writeFile(schemaPath, schema);
  const hash = crypto.createHash("sha256").update(schema).digest("hex");
  const cached = await fs.readFile(hashFile, "utf8").catch(() => "");
  if (cached.trim() !== hash || !(await fs.stat(path.join(clientDir, "index.js")).catch(() => null))) {
    await fs.rm(clientDir, { recursive: true, force: true });
    await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], {
      cwd: REPO,
      timeout: 180000,
    });
    await fs.mkdir(clientDir, { recursive: true });
    await fs.writeFile(hashFile, hash);
    console.log("  (test prisma client generated)");
  } else {
    console.log("  (test prisma client reused)");
  }

  const dbFile = path.join(tmpRoot, "test.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.DB_PROVIDER = "sqlite";
  await run(path.join(REPO, "node_modules", ".bin", "prisma"),
    ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
    { cwd: REPO, timeout: 120000, env: process.env });

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  await prisma.$queryRawUnsafe("PRAGMA database_list");

  const user = await prisma.user.create({ data: { email: "fan@example.com", name: "Fan" } as any });
  const ago = (ms: number) => new Date(Date.now() - ms);

  const { anyoneActive, resetActivityCache, ACTIVE_WINDOW_MS } = await import("../lib/activity.ts");
  ok(ACTIVE_WINDOW_MS === 5 * 60 * 1000, "window matches the presence route (5 min)");

  // Empty station: nobody here.
  ok((await anyoneActive()) === false, "no heartbeats -> inactive");

  // Fresh heartbeat: someone here.
  await prisma.presenceHeartbeat.create({ data: { userId: user.id, lastSeen: new Date() } as any });
  resetActivityCache();
  ok((await anyoneActive()) === true, "fresh heartbeat -> active");

  // Recent but not brand-new: still here.
  await prisma.presenceHeartbeat.update({ where: { userId: user.id }, data: { lastSeen: ago(4 * 60 * 1000) } });
  resetActivityCache();
  ok((await anyoneActive()) === true, "4-minute heartbeat -> active");

  // Aged out: gone.
  await prisma.presenceHeartbeat.update({ where: { userId: user.id }, data: { lastSeen: ago(6 * 60 * 1000) } });
  resetActivityCache();
  ok((await anyoneActive()) === false, "6-minute heartbeat -> inactive");

  // The answer is cached: deleting the row must not flip it until reset.
  await prisma.presenceHeartbeat.update({ where: { userId: user.id }, data: { lastSeen: new Date() } });
  resetActivityCache();
  ok((await anyoneActive()) === true, "recheck true before delete");
  await prisma.presenceHeartbeat.delete({ where: { userId: user.id } });
  ok((await anyoneActive()) === true, "cached answer survives the delete");
  resetActivityCache();
  ok((await anyoneActive()) === false, "reset re-reads the empty table");

  await prisma.$disconnect();
  console.log(`  ${passed}/${passed + failed} activity assertions passed`);
  if (failed > 0) process.exit(1);
} finally {
  await cleanup();
}
