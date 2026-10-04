// End-to-end test for the automatic-update tick against a scratch station.
//
// Builds a throwaway copy of this repo at $SCRATCH_DIR (default under os.tmpdir),
// serves a stub Subwave backend (listeners + timezone), seeds auto-update
// settings with a window covering RIGHT NOW in Hobart time, then calls
// runAutoUpdateTick() and asserts a real pipeline ran: backup created and
// validated, source updated, job done, source record written.
//
// The pipeline's final pm2 restart fails gracefully here (no pm2) — that step
// is covered by the docker E2E instead. What this proves: the tick decides,
// plans, backs up, swaps, migrates, builds and records, unsupervised.
//
//   SCRATCH_KEEP=1 keeps the tree for post-mortem (and SCRATCH_DIR reuses it).
//   TEST_PRISMA_CLIENT must be exported before node starts (hook workers only
//   see spawn-time env) — the npm script does this.
//   node --import ./scripts/test-register.mjs e2e/drive-auto-update.mjs
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();

let passed = 0;
let failed = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const scratch = process.env.SCRATCH_DIR || (await fs.mkdtemp(path.join(os.tmpdir(), "subwave-auto-e2e-")));
const managedScratch = !process.env.SCRATCH_DIR;
try {
  // ---- 1. scratch tree: source + deps, no git, no data ----
  console.log("  …copying tree (one time, ~1 min)");
  await fs.mkdir(scratch, { recursive: true });
  await new Promise((resolve, reject) => {
    const excludes = ["./node_modules", "./.next", "./.git", "./data", "./.test-client"].flatMap((e) => [
      "--exclude",
      e,
    ]);
    const a = spawn("tar", [...excludes, "-cf", "-", "."], { cwd: REPO });
    const b = spawn("tar", ["-xf", "-", "-C", scratch]);
    a.stdout.pipe(b.stdin);
    b.on("close", (c) => (c === 0 ? resolve(null) : reject(new Error("untar failed"))));
    a.on("error", reject);
  });
  // Real node_modules: tar pipe, because cp -r materializes .bin symlinks into
  // real files and prisma resolves its engine wasm relative to its own path —
  // a materialized .bin/prisma looks in .bin/ instead of ../prisma/build/.
  await new Promise((resolve, reject) => {
    const a = spawn("tar", ["-cf", "-", "node_modules"], { cwd: REPO });
    const b = spawn("tar", ["-xf", "-", "-C", scratch]);
    a.stdout.pipe(b.stdin);
    b.on("close", (c) => (c === 0 ? resolve(null) : reject(new Error("node_modules copy failed"))));
    a.on("error", reject);
  });
  ok((await fs.stat(path.join(scratch, "app", "page.tsx")).catch(() => null)) !== null, "scratch tree copied");

  // ---- 2. stub backend: quiet room, Hobart station ----
  const stub = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/api/now-playing")) res.end(JSON.stringify({ listeners: { current: 0 } }));
    else if (req.url.startsWith("/api/state"))
      res.end(JSON.stringify({ timezone: "Australia/Hobart", station: { name: "Stub FM" } }));
    else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubPort = stub.address().port;
  process.env.SUBWAVE_API_URL = `http://127.0.0.1:${stubPort}/api`;

  // ---- 3. scratch database + settings (before any lib import reads env) ----
  const dbUrl = `file:${path.join(scratch, "data", "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  process.env.DB_PROVIDER = "sqlite";
  const { ensureTestClient } = await import("../scripts/ensure-test-client.mjs");
  await ensureTestClient(REPO, dbUrl);
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const nowHobartMin = (() => {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Hobart",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    return Number(p.find((x) => x.type === "hour").value) * 60 + Number(p.find((x) => x.type === "minute").value);
  })();
  const fmt = (m) => {
    const n = (((m % 1440) + 1440) % 1440) * 1;
    return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
  };
  const start = fmt(nowHobartMin - 60);
  const end = fmt(nowHobartMin + 60);
  for (const [k, v] of [
    ["autoUpdateEnabled", "true"],
    ["autoUpdateStart", start],
    ["autoUpdateEnd", end],
    ["updateChannel", "develop"],
  ]) {
    await prisma.setting.upsert({ where: { key: k }, update: { value: v }, create: { key: k, value: v } });
  }
  console.log(`  …window ${start}–${end} Hobart (covers now)`);
  await prisma.$disconnect();

  // ---- 4. run the tick with cwd inside scratch (backup paths resolve there) ----
  // The tick backs up .env.local and validates it (required keys included), so
  // the scratch station needs a real one — like every production station has.
  await fs.writeFile(
    path.join(scratch, ".env.local"),
    [
      `DATABASE_URL="file:./data/test.db"`,
      `DB_PROVIDER=sqlite`,
      `PII_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001`,
      `NEXTAUTH_SECRET=scratch-secret`,
      `GOOGLE_CLIENT_ID=scratch-client-id`,
      `NEXTAUTH_URL=http://127.0.0.1:3999`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  process.chdir(scratch);
  const { runAutoUpdateTick } = await import("../lib/auto-update.ts");
  const decision = await runAutoUpdateTick(scratch);
  ok(decision.start === true, "tick starts the pipeline", JSON.stringify(decision));

  // The tick launches without awaiting — poll the job file to completion.
  let job = null;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      job = JSON.parse(await fs.readFile(path.join(scratch, "data", "update-job.json"), "utf8"));
      if (job.status !== "running") break;
    } catch {
      // not written yet
    }
  }
  ok(job !== null && job.status === "done", "pipeline reaches done", job ? job.status : "no job file");
  if (job && job.status !== "done") {
    console.log(`  .... job error: ${(job.error || "").slice(0, 500)}`);
    console.log(`  .... job log tail: ${(job.log || []).slice(-3).join(" | ").slice(0, 300)}`);
  }

  // ---- 5. assert the aftermath on disk ----
  if (job) {
    ok(job.trigger === "auto", "job marked automatic");
    ok((job.log.join("\n")).includes("backup validated"), "backup validated in-pipeline");
    const backups = await fs.readdir(path.join(scratch, "data", "backups")).catch(() => []);
    const autoBackups = [];
    for (const id of backups) {
      try {
        const m = JSON.parse(
          await fs.readFile(path.join(scratch, "data", "backups", id, "manifest.json"), "utf8")
        );
        if (typeof m.label === "string" && m.label.startsWith("pre-update-")) autoBackups.push(id);
      } catch {
        // ignore
      }
    }
    ok(autoBackups.length >= 1, "pre-update backup exists");
    let source = null;
    try {
      source = JSON.parse(await fs.readFile(path.join(scratch, "data", "update-source.json"), "utf8"));
    } catch {
      // Absent when the pipeline never got that far — the job log below says where.
    }
    ok(
      source !== null && source.channel === "develop" && typeof source.sha === "string",
      "source record written"
    );
    // Notification dedup: no push infra here, so pushToAdmins is a no-op — but
    // the ref record proves the exactly-once path ran, and the staged tarball
    // proves the notification (had there been a device) promised something real.
    if (source !== null && typeof source.sha === "string") {
      const { notifiedRefFor } = await import("../lib/update.ts");
      const notified = await prisma.setting.findUnique({ where: { key: "updateNotifiedRef" } }).catch(() => null);
      ok(notified !== null && notified.value === notifiedRefFor("develop", source.sha), "notified-once ref recorded");
      const staged = await fs.readdir(path.join(scratch, "data", "update-staged")).catch(() => []);
      ok(staged.some((f) => f === `develop-${source.sha}.tar.gz`), "verified tarball staged");
    } else {
      ok(false, "notified-once ref recorded", "no source record");
      ok(false, "verified tarball staged", "no source record");
    }
    const snap = await fs.stat(path.join(scratch, "data", "update-source-snapshot.tar.gz")).catch(() => null);
    ok(snap !== null && snap.size > 1024, "source snapshot retained");
  }

  stub.close();
} finally {
  try {
    process.chdir(REPO);
  } catch {
    // already home
  }
  if (process.env.SCRATCH_KEEP) {
    console.log(`  (keeping ${scratch})`);
  } else if (managedScratch) {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

console.log(`\n  ${passed}/${passed + failed} auto e2e assertions passed`);
if (failed) process.exitCode = 1;
