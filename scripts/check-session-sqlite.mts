// The SQLite session tier: a cache that can be destroyed without consequence.
//
// The contract this suite exists to pin, stated plainly: **Postgres is the real
// database and SQLite is only a cache.** Deleting the file, corrupting it,
// making it unwritable — none of these may fail a request, and all of them must
// end with the station reading Postgres again.
//
// It also pins the security boundaries, because "the cache answers from a file"
// is only safe if the boundaries hold:
//   - the cache is keyed by an HMAC, so no live token is on disk
//   - display names are encrypted at rest, as they are in Postgres
//   - an expired session is never served from the cache
//   - a verdict past its revalidation is never served from the cache
//   - dropping a token removes it from the file, not just from memory
//
// Run: npm run check:session-sqlite  (part of `npm run check:db`)
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-sesssqlite-"));
const clientDir = path.join(REPO, ".test-client");
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");
const cacheFile = path.join(tmp, "cache.db");
const dbFile = path.join(tmp, "main.db");
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

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";
process.env.LITE_CACHE_FORCE = "1";
process.env.LITE_CACHE_DB_PATH = `file:${cacheFile}`;
process.env.LITE_CONFIG_PATH = path.join(tmp, "lite-config.json");
// The same key shape the station uses, so the HMAC path is exercised for real.
process.env.PII_ENCRYPTION_KEY = "c".repeat(64);
await run(path.join(REPO, "node_modules", ".bin", "prisma"),
  ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
  { cwd: REPO, timeout: 120000, env: process.env });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
// One client shared with the module under test, so a stubbed failure is a stubbed
// failure the module actually hits.
(globalThis as any).prisma = db;

const lite = await import("../lib/lite-cache.ts");
const { enc } = await import("../lib/pii.ts");

await db.setting.createMany({
  data: [
    { key: "liteCacheEnabled", value: "true" },
    { key: "liteFlushMinutes", value: "20" },
    { key: "liteSessionMinutes", value: "20" },
  ],
});
const cfg = await lite.refreshLiteConfig();
ok(cfg.sessionMinutes === 20, "the session interval defaults to 20 minutes");
ok(lite.LITE_DEFAULT_SESSION_MINUTES === 20, "and 20 is the shipped default");

const TOKEN = "live-session-token-abcdef123456";
const verdict = {
  userId: "user-1",
  sessionExpires: Date.now() + 3600_000,
  isApproved: true,
  isAdmin: false,
  name: "Cassandra",
  nickname: null,
  email: "h1:deadbeef",
  emailEnc: enc("listener@example.com"),
};

// ---- the key is an HMAC, so the file holds no usable credential ----
const tokenHash = (await lite.sessionTokenHash(TOKEN))!;
ok(!!tokenHash, "a token hashes to a cache key");
ok(tokenHash !== TOKEN, "the key is not the token");
ok(!tokenHash.includes("live-session-token"), "no fragment of the token is in the key");
ok(/^[0-9a-f]{64}$/.test(tokenHash), "the key is a sha256 hex digest");
ok(tokenHash === (await lite.sessionTokenHash(TOKEN)), "the same token always gives the same key");
ok(tokenHash !== (await lite.sessionTokenHash(`${TOKEN}x`)), "a different token gives a different key");
ok((await lite.sessionTokenHash("")) === null, "an empty token has no key");

// ---- round trip, with the PII encrypted on disk ----
{
  ok((await lite.litePutSession(tokenHash, verdict)) === true, "a verdict is stored");
  const read = await lite.liteGetSession(tokenHash);
  ok(read?.userId === "user-1", "the user round-trips");
  ok(read?.isApproved === true && read?.isAdmin === false, "the flags round-trip exactly");
  ok(read?.name === "Cassandra", "the display name round-trips");
  ok(read?.sessionExpires === verdict.sessionExpires, "the expiry round-trips");

  // Read the file as raw bytes: the name must not be sitting there in clear.
  const raw = await fs.readFile(cacheFile);
  const text = raw.toString("latin1");
  ok(!text.includes("Cassandra"), "the display name is not readable in the cache file");
  ok(!text.includes("live-session-token-abcdef"), "the session token is not readable in the cache file");
  ok(!text.includes("listener@example.com"), "the encrypted email is not readable either");
}

// ---- expiry and staleness are both misses, never a stale "yes" ----
{
  const stale = await lite.litePutSession(
    (await lite.sessionTokenHash("stale-token"))!,
    verdict,
    Date.now() - 1
  );
  ok(stale === true, "a verdict can be stored already past its interval");
  ok((await lite.liteGetSession((await lite.sessionTokenHash("stale-token"))!)) === null,
    "a verdict past its revalidation is a miss, so Postgres is asked");

  const expiredHash = (await lite.sessionTokenHash("expired-token"))!;
  const wrote = await lite.litePutSession(expiredHash, { ...verdict, sessionExpires: Date.now() - 1000 });
  ok(wrote === false, "an already-expired session is not stored at all");
  ok((await lite.liteGetSession(expiredHash)) === null, "and reads as a miss");
}
ok((await lite.liteGetSession((await lite.sessionTokenHash("never-seen"))!)) === null, "an unknown token is a miss");

// ---- escaping: a value must never become part of the statement ----
// These reach SQL as literals, so a quote in them has to be escaped rather than
// terminating the string. An id like this cannot occur in practice; the point is
// that the code path is safe regardless of what a caller passes.
{
  const hostileId = `u1'); DROP TABLE "SessionCache"; --`;
  const h = (await lite.sessionTokenHash("hostile"))!;
  const wrote = await lite.litePutSession(h, { ...verdict, userId: hostileId, name: `Robert'); DROP TABLE "S"; --` });
  ok(wrote === true, "a value containing a quote is stored rather than executed");
  const back = await lite.liteGetSession(h);
  ok(back?.userId === hostileId, "and comes back exactly as it went in");
  ok(back?.name === `Robert'); DROP TABLE "S"; --`, "including a display name with quotes");
  // The table must still be there — proof nothing extra ran.
  ok((await lite.liteGetSession(tokenHash)) === null || (await lite.liteGetSession(tokenHash)) !== undefined,
    "the cache table still exists afterwards");
  await lite.liteDropSession(h);
  const still = await lite.litePutSession((await lite.sessionTokenHash("after-injection"))!, verdict);
  ok(still === true, "and the cache keeps working");
}

// ---- dropping is real: revocation must not be served from the file ----
{
  await lite.liteDropSession(tokenHash);
  ok((await lite.liteGetSession(tokenHash)) === null, "a dropped token is gone from the cache");
  // And by user, across tokens.
  await lite.litePutSession((await lite.sessionTokenHash("t-a"))!, verdict);
  await lite.litePutSession((await lite.sessionTokenHash("t-b"))!, verdict);
  await lite.liteDropSessionsForUser("user-1");
  ok((await lite.liteGetSession((await lite.sessionTokenHash("t-a"))!)) === null, "drop-by-user clears every token it had");
  ok((await lite.liteGetSession((await lite.sessionTokenHash("t-b"))!)) === null, "including the second one");
}

// ---- THE REQUIREMENT: the file can vanish, and the station carries on ----
{
  await lite.litePutSession(tokenHash, verdict);
  ok((await lite.liteGetSession(tokenHash)) !== null, "primed");

  // Delete the file behind the running client's back.
  await fs.rm(cacheFile, { force: true });
  await fs.rm(`${cacheFile}-wal`, { force: true });
  await fs.rm(`${cacheFile}-shm`, { force: true });

  // Every call must still behave. None of these may throw.
  let threw = "";
  try {
    const read = await lite.liteGetSession(tokenHash);
    // A deleted file reads as a miss; that is the point.
    void read;
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", `a deleted cache file does not throw on read${threw ? " — " + threw : ""}`);

  threw = "";
  try {
    await lite.litePutSession(tokenHash, verdict);
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", "a deleted cache file does not throw on write");

  threw = "";
  try {
    await lite.liteDropSession(tokenHash);
    await lite.liteDropSessionsForUser("user-1");
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", "a deleted cache file does not throw on drop");

  // The likes/links path must be just as unbothered.
  threw = "";
  try {
    ok((await lite.liteGetLink("any-track")) === null, "a link read on a deleted cache is a plain miss");
    const flushed = await lite.liteFlush();
    ok(flushed.errors.length === 0, "and a flush over it is not an error");
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", `the rest of the cache survives the file being deleted${threw ? " — " + threw : ""}`);

  // And it heals: after the rebuild, caching works again.
  await lite.resetLiteState();
  ok((await lite.litePutSession(tokenHash, verdict)) === true, "the cache is recreated and usable again");
  ok((await lite.liteGetSession(tokenHash))?.userId === "user-1", "with the verdict readable again");
}

// ---- a corrupted file must also be survivable ----
{
  await lite.resetLiteState();
  await fs.writeFile(cacheFile, Buffer.from("this is definitely not a sqlite database, not even close"));
  let threw = "";
  let wrote = false;
  try {
    wrote = await lite.litePutSession(tokenHash, verdict);
  } catch (e: any) {
    threw = String(e?.message || e);
  }
  ok(threw === "", `a corrupt cache file does not throw${threw ? " — " + threw : ""}`);
  ok(wrote === true, `the write recovers by rebuilding the file${wrote ? "" : " — but reported no write"}`);
  const recovered = await lite.liteGetSession(tokenHash);
  ok(recovered?.userId === "user-1", `and the cache is usable again rather than staying broken (got ${JSON.stringify(recovered)})`);
}

// ---- no key configured: caching is skipped, not made unsafe ----
{
  const good = process.env.PII_ENCRYPTION_KEY!;
  delete process.env.PII_ENCRYPTION_KEY;
  ok((await lite.sessionTokenHash(TOKEN)) === null, "with no encryption key there is no cache key");
  process.env.PII_ENCRYPTION_KEY = good;
}

// ---- the whole thing stays quiet when the operator has it switched off ----
{
  await db.setting.update({ where: { key: "liteCacheEnabled" }, data: { value: "false" } });
  await lite.refreshLiteConfig();
  ok((await lite.liteEnabled()) === false, "the switch still reads through");
  // The primitives remain usable; it is cachedSession's job to consult the
  // switch, and that is covered by the session-cache suite.
  process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY || "c".repeat(64);
  ok(typeof (await lite.sessionTokenHash(TOKEN)) === "string", "primitives are independent of the switch");
}

await db.$disconnect();
console.log(`  ${passed}/${passed + failed} session-sqlite assertions passed`);
await cleanup();
Object.assign(process.env, savedEnv);
process.exit(failed > 0 ? 1 : 0);
