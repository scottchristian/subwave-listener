// Backup round-trip + edge cases. The rollback contract lives or dies here:
// create → mutate everything → restore → byte-identical. Plus guards, prune,
// archive integrity and the env parser.
//
// Hermetic by construction: a throwaway sqlite client is generated into the OS
// temp dir (never node_modules), the database, env file, brand tree and backups
// all live under a temp app root that becomes process.cwd() before lib/backup
// loads (its paths resolve at module load). Nothing in the repo is touched —
// the only repo file created is prisma/.gen-test.prisma, removed on the way out.
//
// Run: node --import ./scripts/test-register.mjs scripts/check-backup.mts
// (wired as `npm run check:backup`). Needs TEST_REPO_ROOT set — the package.json
// script sets it; running by hand needs TEST_REPO_ROOT=$PWD.
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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-backup-test-"));
const appRoot = path.join(tmpRoot, "app");
const clientDir = path.join(os.tmpdir(), "subwave-test-client");
const hashFile = path.join(clientDir, "schema.sha256");
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");

async function cleanup() {
  try {
    process.chdir(REPO);
  } catch {}
  // KEEP_TEST_DIR=1 leaves the app root behind for post-mortem (db file included).
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
  // ---- Phase 0: throwaway sqlite client (hash-gated, reused across runs) ----
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
  process.env.TEST_PRISMA_CLIENT = clientDir;

  // ---- Phase 1: fixtures ----
  const dbFile = path.join(tmpRoot, "test.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.DB_PROVIDER = "sqlite";
  await run(path.join(REPO, "node_modules", ".bin", "prisma"),
    ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
    { cwd: REPO, timeout: 120000, env: process.env });

  await fs.mkdir(path.join(appRoot, "data", "brand", "icons"), { recursive: true });
  const envRaw =
    `# station env — comments and export lines must survive a round-trip\n` +
    `DATABASE_URL="file:../data/test.db"\n` +
    `DB_PROVIDER=sqlite\n` +
    `PII_ENCRYPTION_KEY="abc123"\n` +
    `QUOTED="she said \\"hi\\" \\\\ done"\n` +
    `EQUALS="a=b=c"\n` +
    `EMPTY=\n` +
    `SPACED="  padded  "\n` +
    `export LEGACY_VAR=kept\n` +
    `NEXTAUTH_URL=http://localhost:9999\n`;
  await fs.writeFile(path.join(appRoot, ".env.local"), envRaw, { mode: 0o600 });
  await fs.writeFile(path.join(appRoot, "data", "brand", "logo.png"), "fake-logo-bytes");
  await fs.writeFile(path.join(appRoot, "data", "brand", "icons", "icon-192.png"), "fake-icon-bytes");
  await fs.writeFile(path.join(appRoot, ".setup-complete"), "done");

  // Become the app root BEFORE lib/backup resolves its paths at module load.
  process.chdir(appRoot);
  const backup = await import("../lib/backup.ts");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  // Seed: users with dependents (FK order matters), secrets-looking settings,
  // and volume on the history table.
  const u1 = await prisma.user.create({ data: { email: "op@example.com", name: "Op", isAdmin: true } as any });
  const u2 = await prisma.user.create({ data: { email: "fan@example.com", name: "Fan" } as any });
  await prisma.session.create({ data: { sessionToken: "tok1", userId: u1.id, expires: new Date() } });
  await prisma.account.create({ data: { userId: u1.id, type: "oauth", provider: "google", providerAccountId: "g1" } as any });
  await prisma.pushSubscription.create({
    data: { userId: u2.id, endpoint: "https://push/x", p256dh: "p", auth: "a" } as any,
  });
  await prisma.setting.createMany({
    data: [
      { key: "subwaveAdminPass", value: "s3cr3t!" },
      { key: "donate_text", value: "Tip us" },
      { key: "headerListeners", value: "false" },
    ],
  });
  for (let i = 0; i < 200; i++) {
    await prisma.streamSession.create({
      data: { userId: i % 2 ? u1.id : u2.id, startTime: new Date() } as any,
    });
  }

  // ---- Phase 2: create ----
  const created = await backup.createBackup("round-trip");
  ok(/^[a-z0-9_-]+$/.test(created.id), "backup id is filesystem-safe", created.id);
  ok(created.label === "round-trip", "label kept");
  ok(created.appVersion === (await import("../lib/version.ts")).APP_VERSION, "manifest pins app version");
  ok(created.dbProvider === "sqlite", "manifest records provider");
  ok(created.tables["user"] === 2, "user count", JSON.stringify(created.tables));
  ok(created.tables["session"] === 1, "session count");
  ok(created.tables["account"] === 1, "account count");
  ok(created.tables["setting"] === 3, "setting count");
  ok(created.tables["streamSession"] === 200, "streamSession volume");
  ok(created.tables["pushSubscription"] === 1, "pushSubscription count");
  ok(created.brandFiles === 2, "brand file count");
  ok(created.markerPresent === true, "marker recorded");
  ok(created.envKeys.includes("PII_ENCRYPTION_KEY"), "env keys listed");
  const st = await fs.stat(path.join(appRoot, "data", "backups", created.id));
  ok((st.mode & 0o777) === 0o700, "backup dir is 0700");
  for (const f of ["manifest.json", "env.json", "env.raw", "db.json"]) {
    const m = await fs.stat(path.join(appRoot, "data", "backups", created.id, f));
    ok((m.mode & 0o777) === 0o600, `${f} is 0600`);
  }
  const rawBack = await fs.readFile(path.join(appRoot, "data", "backups", created.id, "env.raw"), "utf8");
  ok(rawBack === envRaw, "env.raw is byte-identical to the env file");

  // ---- Phase 3: mutate everything, restore, compare ----
  const dbBefore = await fs.readFile(path.join(appRoot, "data", "backups", created.id, "db.json"), "utf8");
  await prisma.setting.update({ where: { key: "donate_text" }, data: { value: "MUTATED" } });
  await prisma.setting.create({ data: { key: "rogue", value: "x" } });
  await prisma.user.delete({ where: { id: u2.id } }); // cascades dependents
  await fs.writeFile(path.join(appRoot, "data", "brand", "logo.png"), "different-bytes");
  await fs.rm(path.join(appRoot, "data", "brand", "icons", "icon-192.png"));
  await fs.appendFile(path.join(appRoot, ".env.local"), "\nINJECTED=yes\n");
  await fs.rm(path.join(appRoot, ".setup-complete"));

  const res = await backup.restoreBackup(created.id, true);
  ok(res.tables["setting"] === 3, "restore reports setting count");
  ok(res.tables["user"] === 2, "restore reports user count");

  const dbAfter: Record<string, unknown[]> = {};
  // No orderBy: comparison sorts the serialized rows, and not every table is
  // id-keyed (Setting's key is `key` — an orderBy id there throws, and the catch
  // below would silently report an empty table, which is exactly the false
  // failure this comment exists to prevent from recurring).
  for (const t of ["user", "account", "session", "streamSession", "setting", "pushSubscription"]) {
    dbAfter[t] = await (prisma as any)[t].findMany().catch((e: unknown) => {
      throw new Error(`re-read of ${t} failed: ${(e as Error).message}`);
    });
  }
  const norm = (v: unknown) => JSON.parse(JSON.stringify(v));
  const dbBeforeParsed = JSON.parse(dbBefore);
  let tablesMatch = true;
  for (const t of Object.keys(dbAfter)) {
    const a = norm(dbBeforeParsed[t] || []).map((r: any) => JSON.stringify(r)).sort();
    const b = norm(dbAfter[t]).map((r: any) => JSON.stringify(r)).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      tablesMatch = false;
      const onlyA = a.filter((x: string) => !b.includes(x)).slice(0, 3);
      const onlyB = b.filter((x: string) => !a.includes(x)).slice(0, 3);
      console.log(`  FAIL  table ${t} differs after restore`);
      console.log(`    only in backup:  ${JSON.stringify(onlyA).slice(0, 300)}`);
      console.log(`    only in restored: ${JSON.stringify(onlyB).slice(0, 300)}`);
      failed++;
    } else {
      passed++;
    }
  }
  ok(tablesMatch, "every table byte-identical after restore");
  const rogue = await prisma.setting.findUnique({ where: { key: "rogue" } });
  ok(rogue === null, "post-backup row is gone after restore");
  const envAfter = await fs.readFile(path.join(appRoot, ".env.local"), "utf8");
  ok(envAfter === envRaw, "env file byte-identical after restore");
  ok(
    (await fs.readFile(path.join(appRoot, "data", "brand", "logo.png"), "utf8")) === "fake-logo-bytes",
    "brand file contents restored"
  );
  ok(
    (await fs.readFile(path.join(appRoot, "data", "brand", "icons", "icon-192.png"), "utf8")) === "fake-icon-bytes",
    "deleted brand file restored"
  );
  ok(
    (await fs.readFile(path.join(appRoot, ".setup-complete"), "utf8")) === "done",
    "marker restored"
  );

  // ---- Phase 4: guards ----
  let threw = false;
  try {
    await backup.restoreBackup(created.id, false);
  } catch (e) {
    threw = /confirmation/.test((e as Error).message);
  }
  ok(threw, "restore without confirm:true refuses");
  threw = false;
  try {
    await backup.restoreBackup("../../../etc", true);
  } catch {
    threw = true;
  }
  ok(threw, "path traversal id rejected");
  threw = false;
  try {
    await backup.restoreBackup("does-not-exist", true);
  } catch {
    threw = true;
  }
  ok(threw, "unknown id rejected");
  // Junk in the backups dir is listed, never.
  await fs.mkdir(path.join(appRoot, "data", "backups", "junk-dir"));
  await fs.writeFile(path.join(appRoot, "data", "backups", "stray.tar.gz"), "x");
  const listed = await backup.listBackups();
  ok(!listed.some((b) => b.id === "junk-dir"), "list ignores junk dirs and stray files");

  // ---- Phase 5: archive integrity ----
  const { filePath, fileName } = await backup.archiveBackup(created.id);
  ok(
    /^[a-z0-9-]+-[a-z0-9-]+-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z0-9]+\.tar\.gz$/.test(fileName),
    "download filename carries app, station and id",
    fileName
  );
  ok(!/\s/.test(fileName), "download filename has no whitespace", fileName);
  const { execFile: exec2 } = await import("node:child_process");
  const { promisify: prom2 } = await import("node:util");
  const listing = (await prom2(exec2)("tar", ["-tzf", filePath]).then((r: any) => r.stdout).catch(() => "")) as string;
  for (const f of ["manifest.json", "env.json", "env.raw", "db.json", "brand/logo.png"]) {
    ok(listing.includes(`${created.id}/${f}`), `archive contains ${f}`);
  }
  await backup.removeArchive(filePath);
  ok(!(await fs.stat(filePath).catch(() => null)), "temp archive removed after download");

  // ---- Phase 6: prune keeps the newest 10 ----
  for (let i = 0; i < 11; i++) {
    await backup.createBackup(`prune-${i}`);
  }
  const afterPrune = await backup.listBackups();
  ok(afterPrune.length === 10, "retention holds at 10", `got ${afterPrune.length}`);
  ok(afterPrune.every((b) => b.label.startsWith("prune-")), "oldest (round-trip) was pruned first");

  // ---- Phase 7: env parser edges (pure) ----
  const parsed = backup.parseEnvFile(
    `# comment\nEMPTY=\nPLAIN=x\nQUOTED="a=b"\nESC="q\\"r\\\\s"\nSP="  p  "\nNOT_A_LINE\n`
  );
  ok(parsed["EMPTY"] === "", "empty value");
  ok(parsed["PLAIN"] === "x", "plain value");
  ok(parsed["QUOTED"] === "a=b", "= inside quotes");
  ok(parsed["ESC"] === 'q"r\\s', "escaped quote and backslash");
  ok(parsed["SP"] === "  p  ", "inner padding kept");
  ok(!("NOT_A_LINE" in parsed), "non-assignments skipped");
  ok(!("# comment" in parsed), "comments skipped");

  // ---- Phase 7b: filename slugs ----
  const slugs: Array<[string, string, string]> = [
    ["Causeway FM", "causeway-fm", "spaces"],
    ["  Padded  ", "padded", "padding trimmed"],
    ["Rock & Roll!", "rock-roll", "punctuation"],
    ["UPPER", "upper", "case"],
    ["a".repeat(100), "a".repeat(60), "capped at 60"],
    ["", "station", "empty falls back"],
    ["!!!", "station", "punctuation-only falls back"],
    ["caf\u00e9", "caf", "non-ascii dropped"],
  ];
  for (const [raw, want, why] of slugs) {
    const got = backup.slugifyName(raw, "station");
    if (got !== want) {
      failed++;
      console.log(`  FAIL  slugify(${JSON.stringify(raw)}) -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)} (${why})`);
    } else {
      passed++;
    }
  }

  // ---- Phase 8: delete ----
  await backup.deleteBackup(afterPrune[0].id);
  const afterDelete = await backup.listBackups();
  ok(afterDelete.length === 9 && !afterDelete.some((b) => b.id === afterPrune[0].id), "delete removes one");

  await prisma.$disconnect();
} finally {
  await cleanup();
}

console.log(`  ${passed}/${passed + failed} backup assertions passed`);
// exitCode, not exit(): the finally above still has to remove the temp app root.
if (failed) process.exitCode = 1;
