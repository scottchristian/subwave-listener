// SQLite write-back cache: likes + link lookups buffer locally, flush to
// Postgres on a timer. The "Postgres" here is a second sqlite file behind the
// throwaway test client — same models, same SQL paths, zero network.
//
// Hermetic like check-backup: nothing in the repo touched except
// prisma/.gen-test.prisma (removed on the way out). LITE_CACHE_FORCE=1 makes
// the module skip its postgres-only gate; LITE_CACHE_DB_PATH points the
// mirror at a temp file.
//
// Run: TEST_PRISMA_CLIENT="$PWD/.test-client" node --import ./scripts/test-register.mjs scripts/check-lite-cache.mts
// (wired as `npm run check:lite-cache`).
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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-lite-test-"));
const clientDir = path.join(REPO, ".test-client");
const hashFile = path.join(clientDir, "schema.sha256");
if (!process.env.TEST_PRISMA_CLIENT) {
  throw new Error("TEST_PRISMA_CLIENT is not set — run via `npm run check:lite-cache`");
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

  // Main database stands in for Postgres; cache file stands alone.
  const dbFile = path.join(tmpRoot, "main.db");
  const cacheFile = path.join(tmpRoot, "cache.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.LITE_CACHE_FORCE = "1";
  process.env.LITE_CACHE_DB_PATH = `file:${cacheFile}`;
  process.env.LITE_CONFIG_PATH = path.join(tmpRoot, "lite-config.json");
  await run(path.join(REPO, "node_modules", ".bin", "prisma"),
    ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
    { cwd: REPO, timeout: 120000, env: process.env });

  const { PrismaClient } = await import("@prisma/client");
  const pg = new PrismaClient();
  await pg.$queryRawUnsafe("PRAGMA database_list");

  // lib/prisma reuses a client left on globalThis, so hand it this one. The
  // module and the test then share a single instance, which is what lets the
  // failure-path assertions below stub an upsert the module will actually call
  // (two clients over one file would make that stub a no-op).
  (globalThis as any).prisma = pg;

  const lite = await import("../lib/lite-cache.ts");
  const user = await pg.user.create({ data: { email: "fan@example.com", name: "Fan" } as any });

  // Enable through the real settings path.
  await pg.setting.createMany({
    data: [
      { key: "liteCacheEnabled", value: "true" },
      { key: "liteFlushMinutes", value: "20" },
    ],
  });
  const cfg = await lite.refreshLiteConfig();
  ok(cfg.enabled === true && cfg.minutes === 20, "switch reads through settings");
  ok((await lite.liteEnabled()) === true, "enabled under test hook");

  // ---- Links: miss, buffer, hit without touching Postgres ----
  ok((await lite.liteGetLink("t1")) === null, "cold link cache misses");
  ok((await lite.litePutLink({ trackId: "t1", spotifyUrl: "https://sp/t1", appleMusicUrl: null, explicit: true })) === true, "link buffers");
  const hit = await lite.liteGetLink("t1");
  ok(hit?.spotifyUrl === "https://sp/t1" && hit?.explicit === true, "buffered link reads back");
  ok((await pg.songLinkCache.findUnique({ where: { trackId: "t1" } })) === null, "Postgres untouched before flush");

  // ---- Likes: buffer, merge, flush converges ids ----
  const put = await lite.litePutLike({ userId: user.id, trackId: "s1", title: "Song" });
  ok(!!put?.id, "like buffers with an id");
  ok((await pg.songLike.findMany({ where: { userId: user.id } })).length === 0, "Postgres untouched before flush");
  const merged = lite.mergeLikeRows(
    await pg.songLike.findMany({ where: { userId: user.id } }),
    await lite.liteListMine(user.id)
  );
  ok(merged.length === 1 && merged[0].title === "Song", "mine merges the buffered tap");
  const res = await lite.liteFlush();
  ok(res.errors.length === 0 && res.likes === 1 && res.links === 1, `flush pushes both tables (got ${JSON.stringify(res)})`);
  const pgLikes = await pg.songLike.findMany({ where: { userId: user.id } });
  ok(pgLikes.length === 1 && pgLikes[0].id === put?.id, "flush converges on the same id (no fork)");
  const merged2 = lite.mergeLikeRows(pgLikes, await lite.liteListMine(user.id));
  ok(merged2.length === 1, "post-flush merge has no duplicates");

  // ---- The flush must DRAIN, or it re-pushes the same rows for ever ----
  // A cache that never empties costs a query per row per interval and, on a
  // free tier, keeps the database permanently awake on a timer.
  ok((await lite.liteListMine(user.id)).length === 0, "confirmed likes leave the mirror");
  ok((await lite.liteGetLink("t1")) === null, "confirmed links leave the mirror");
  const idle = await lite.liteFlush();
  ok(idle.likes === 0 && idle.links === 0 && idle.errors.length === 0, "a second flush over an empty cache does no work");
  // Re-buffering after a drain still reaches Postgres.
  await lite.litePutLike({ userId: user.id, trackId: "s1b", title: "After drain" });
  const again2 = await lite.liteFlush();
  ok(again2.likes === 1, "a row buffered after a drain still flushes");
  ok((await pg.songLike.count({ where: { userId: user.id, trackId: "s1b" } })) === 1, "and lands in Postgres");
  ok(!(await lite.liteListMine(user.id)).some((r) => r.trackId === "s1b"), "draining again empties the mirror");

  // A row Postgres refuses must STAY in the mirror, or it is lost from both.
  {
    const stuck = await lite.litePutLike({ userId: user.id, trackId: "s1c", title: "Stuck" });
    const realUpsert = pg.songLike.upsert.bind(pg.songLike);
    (pg.songLike as any).upsert = async () => { throw new Error("simulated Postgres failure"); };
    const failed = await lite.liteFlush();
    (pg.songLike as any).upsert = realUpsert;
    ok(failed.errors.length === 1 && failed.likes === 0, "a failed push is reported, not counted as flushed");
    const still = await lite.liteListMine(user.id);
    ok(still.some((r) => r.id === stuck?.id), "the failed row stays in the mirror for the next attempt");
    ok((await pg.songLike.count({ where: { userId: user.id, trackId: "s1c" } })) === 0, "and is absent from Postgres, so nothing was lost");
    const retried = await lite.liteFlush();
    ok(retried.likes === 1 && retried.errors.length === 0, "the retry succeeds once Postgres is well");
    ok(!(await lite.liteListMine(user.id)).some((r) => r.trackId === "s1c"), "and then the mirror drains");
    await pg.songLike.deleteMany({ where: { userId: user.id } });
  }

  // ---- Unlike of a never-flushed like: sqlite gone, Postgres P2025 ignored ----
  await lite.litePutLike({ userId: user.id, trackId: "s2" });
  await lite.liteDeleteLike(user.id, "s2");
  let threw = "";
  try {
    await pg.songLike.delete({ where: { userId_trackId: { userId: user.id, trackId: "s2" } } });
  } catch (e: any) {
    threw = String(e?.code || e?.message || "");
  }
  ok(/P2025/.test(threw), "deleting the never-flushed row raises P2025 upstream");
  ok((await lite.liteListMine(user.id)).filter((r) => r.trackId === "s2").length === 0, "buffered copy gone");

  // ---- Unlike of a flushed like removes both ----
  await pg.songLike.delete({ where: { userId_trackId: { userId: user.id, trackId: "s1" } } }).catch(() => {});
  await lite.liteDeleteLike(user.id, "s1");
  ok((await lite.liteListMine(user.id)).length === 0, "mirror empty after unlike");

  // ---- Track-list memory cache: builds merged, invalidates on tap ----
  await lite.litePutLike({ userId: user.id, trackId: "s3", title: "Three" });
  let built = 0;
  const direct = async () => {
    built++;
    return pg.songLike.findMany({
      where: { trackId: "s3" },
      include: { user: { select: { id: true, name: true, nickname: true, image: true, hideLikeName: true } } },
    });
  };
  const first = await lite.liteTrackLikes("s3", direct, (row, u) => ({ ...row, user: u }), (r: any) => r.id);
  ok(built === 1 && first.length === 1, "track list builds merged once");
  const second = await lite.liteTrackLikes("s3", direct, (row, u) => ({ ...row, user: u }), (r: any) => r.id);
  ok(built === 1 && second.length === 1, "track list serves memory on repeat");
  lite.invalidateTrackCache("s3");
  await lite.liteTrackLikes("s3", direct, (row, u) => ({ ...row, user: u }), (r: any) => r.id);
  ok(built === 2, "invalidate rebuilds");

  // ---- Disabled: everything passes straight through ----
  await pg.setting.update({ where: { key: "liteCacheEnabled" }, data: { value: "false" } });
  await lite.refreshLiteConfig();
  ok((await lite.liteEnabled()) === false, "switch-off reads through");
  built = 0;
  await lite.liteTrackLikes("s3", direct, (row, u) => ({ ...row, user: u }), (r: any) => r.id);
  ok(built === 1, "disabled track list calls direct");

  // ---- an idle flush must cost the database NOTHING ----
  // The station's whole premise is that an idle station does not touch Postgres,
  // so the database can sleep. A flush over an empty cache reads the local
  // mirror and stops — one query per interval would be enough to hold a free
  // tier awake for ever, since the interval is longer than the sleep window.
  //
  // Proven by making every Postgres call an explosion: if the flush reaches for
  // the database at all, this fails loudly rather than quietly costing a query.
  {
    await lite.liteFlush(); // drain anything the cases above left buffered
    const client: any = (globalThis as any).prisma;
    const saved = {
      songLike: client.songLike,
      songLinkCache: client.songLinkCache,
      setting: client.setting,
    };
    let touched = 0;
    const trap = () => { touched++; throw new Error("the idle flush reached for Postgres"); };
    for (const model of ["songLike", "songLinkCache", "setting"]) {
      client[model] = new Proxy({}, { get: () => trap });
    }
    let threw = "";
    let res: any = null;
    try {
      res = await lite.liteFlush();
    } catch (e: any) {
      threw = String(e?.message || e);
    }
    for (const [k, v] of Object.entries(saved)) client[k] = v;

    ok(touched === 0, "an empty-cache flush makes no database call at all");
    ok(threw === "", `and does not throw${threw ? " — " + threw : ""}`);
    ok(res?.likes === 0 && res?.links === 0 && res?.errors?.length === 0, "and reports a clean no-op");

    // And with something buffered it must touch the database — proving the trap
    // above was actually armed rather than silently inert.
    await lite.litePutLink({ trackId: "idle-probe", spotifyUrl: "https://sp/probe", appleMusicUrl: null, explicit: false });
    const busy = await lite.liteFlush();
    ok(busy.links === 1, "a flush with something buffered does write to Postgres");
  }

  // ---- the scheduler must stay off the database between flushes ----
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../lib/lite-cache.ts", import.meta.url), "utf8");
    const sched = src.slice(src.indexOf("export function startLiteFlushScheduler"));
    // Resolving the config may fall back to Postgres once, when neither memory
    // nor the file mirror knows anything — that is first boot only, once per
    // process. What must not exist is a refresh INSIDE the flush branch: that
    // is one query per interval, and the interval is longer than the free
    // tier's sleep window, so it would hold the database awake for ever.
    const branch = sched.slice(sched.indexOf("if (postgres &&"));
    const inBranch = (branch.match(/refreshLiteConfig\(/g) ?? []).length;
    ok(inBranch === 0, `the flush branch never re-reads config from Postgres (found ${inBranch})`);
    const total = (sched.match(/refreshLiteConfig\(/g) ?? []).length;
    ok(total === 1, `with exactly one fallback, for first boot (found ${total})`);
    ok(/readLiteConfigFile\(\)/.test(sched), "it reads the local mirror instead");
    ok(!/setInterval\(/.test(sched), "no setInterval, so the loop cannot be left running twice");
  }

  await pg.$disconnect();
  console.log(`  ${passed}/${passed + failed} lite-cache assertions passed`);
  if (failed > 0) process.exit(1);
} finally {
  await cleanup();
}
