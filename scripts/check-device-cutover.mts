// A wall screen must survive a database cutover in both directions.
//
// WHY THIS NEEDS A REAL DATABASE RATHER THAN A SOURCE READ. The station can move
// between SQLite and Postgres at runtime, and it did so on 2026-10-10 — which
// means the schema's datasource block, the generated Prisma client and
// DATABASE_URL can all change underneath a running app. That is a genuinely
// hazardous thing to do to a table holding live credentials, and the failure mode
// is invisible: screens keep polling, keep getting 401, and nobody connects the
// dots for a week.
//
// THE FAILURE THIS SPECIFICALLY GUARDS. MODEL_ORDER drives the copy AND the
// verification. A model missing from it is not an error — it is silently skipped,
// every table still matches, and the copy reports success with the table simply
// absent. A cutover that dropped Device would take out every screen on the wall
// and leave a perfectly clean log. That is the same shape as the deployment one:
// a table that is skipped silently rather than loudly.
//
// SO THIS RUNS THE ACTUAL ROUND TRIP, against a throwaway Postgres in Docker:
// sqlite -> postgres -> sqlite, with Device rows seeded in the states that are
// awkward to lose — a row that exists before its binary (deviceId null), a live
// credential mid-rotation (both hashes set), and the SetNull audit fields pointing
// at a user that then disappears.
//
// Skipped, not failed, when Docker is unavailable: a laptop without it should not
// block a commit, and a check that cannot run must say so rather than pass quietly.
//
// Run: npm run check:device-cutover
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectClient, copyDatabase, MODEL_ORDER, verifyCopy } from "../lib/dbmigrate.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

const TMP = path.join(process.cwd(), ".cutover-test");
const SQLITE_A = path.join(TMP, "a.db");
const SQLITE_B = path.join(TMP, "b.db");
const PG_PORT = 55432;
const PG_URL = `postgresql://cutover:cutover@127.0.0.1:${PG_PORT}/cutover`;
const CONTAINER = "subwave-cutover-test";
const SQLITE_SCHEMA = "prisma/.gen-sqlite.prisma";

function haveDocker(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "pipe" });
  return r.status === 0;
}

if (!haveDocker()) {
  console.log("  note  Docker unavailable — the cutover round trip did not run.");
  console.log(`  ${passed}/${passed + failed} device-cutover assertions passed`);
  process.exit(0);
}

// ---- 0. MODEL_ORDER, asserted before anything expensive -------------------
// Cheapest possible failure, checked first: if this is wrong nothing below means
// anything, because nothing below would copy the table at all.
ok(MODEL_ORDER.includes("device" as never), "device is in MODEL_ORDER, so a cutover copies it");
{
  const userAt = MODEL_ORDER.indexOf("user" as never);
  const deviceAt = MODEL_ORDER.indexOf("device" as never);
  ok(userAt >= 0 && deviceAt > userAt, "device is copied AFTER user", `user@${userAt} device@${deviceAt}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });
}

// ---- 1. a throwaway Postgres ----------------------------------------------
let containerUp = false;
try {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "pipe" });
  // POSTGRES_USER is set explicitly because the image defaults the superuser to
  // "postgres", not to the database name — so a URL built from POSTGRES_DB alone
  // authenticates as the wrong user and fails with a message about credentials
  // rather than about the thing that was actually wrong.
  const up = spawnSync(
    "docker",
    ["run", "-d", "--name", CONTAINER, "-p", `${PG_PORT}:5432`,
     "-e", "POSTGRES_USER=cutover", "-e", "POSTGRES_PASSWORD=cutover",
     "-e", "POSTGRES_DB=cutover", "postgres:16-alpine"],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (up.status !== 0) throw new Error(up.stderr || "could not start postgres");
  containerUp = true;

  // Wait for it to actually accept connections, not just for the container to exist.
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const probe = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "cutover"], { stdio: "pipe" });
    if (probe.status === 0) { ready = true; break; }
    spawnSync("sleep", ["1"]);
  }
  ok(ready, "throwaway postgres is up");

  // ---- 2. the sqlite side, built by the real migrations ------------------
  // `prisma migrate deploy`, not a hand-made schema: the point is to prove the
  // migration that creates Device is replayable, which is exactly the thing that
  // refused to apply on the live station before its history was baselined.
  //
  // DATABASE_URL goes through the environment rather than an argument, because
  // that is how deploy.sh does it and how the running app does it — a scratch
  // path passed any other way would be testing a configuration nobody uses.
  //
  // And the sqlite schema is generated HERE rather than assumed to exist, because
  // it is a gitignored scratch file — and, more importantly, because this check
  // has to work whichever provider prisma/schema.prisma currently names. The
  // whole point of the cutover is that it moves; a check that only ran when the
  // repo happened to be pointing at SQLite would stop running the moment it
  // mattered most.
  if (!fs.existsSync(SQLITE_SCHEMA)) {
    sh("node", ["scripts/gen-schema.mjs", "sqlite", SQLITE_SCHEMA]);
  }
  ok(fs.existsSync(SQLITE_SCHEMA), "the sqlite schema variant is generated for the test");

  sh("npx", ["prisma", "migrate", "deploy", "--schema", SQLITE_SCHEMA], {
    DATABASE_URL: `file:${SQLITE_A}`,
    DB_PROVIDER: "sqlite",
  });
  ok(fs.existsSync(SQLITE_A), "sqlite source built from the real migrations");

  // ---- 3. seed the states that are awkward to lose ----------------------
  {
    const db = await connectClient("sqlite", `file:${SQLITE_A}`);
    await db.user.create({
      data: {
        id: "u1", email: "op@example.invalid", isApproved: true, isAdmin: true,
        hideLikeName: false, createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const base = {
      model: "jc8012p4a1", status: "claimed", buildStatus: "built",
      firmwareSha: "a".repeat(64), builtAt: new Date("2026-01-02T00:00:00Z"),
      firmwareVer: "1.0.0", lastSeenAt: new Date("2026-01-03T00:00:00Z"),
      ip: "192.168.1.84", rssi: -52,
      settingsRev: 3, appliedRev: 3, orientation: "portrait", themeMode: "night",
      brightness: 55, idleMode: "dim", idleMin: 15, idlePct: 20,
      skipEnabled: "1", rotateViews: "0", timezone: "Australia/Hobart",
      lat: -42.8821, lon: 147.3272,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-04T00:00:00Z"),
    };

    // A screen mid-credential-rotation: BOTH hashes set, and the grace window
    // live. This is the single most awkward row shape in the table and the one
    // most likely to be dropped or half-copied by a naive migration.
    await db.device.create({
      data: {
        ...base, id: "d-claimed", name: "Hallway", deviceId: "dev-claimed",
        tokenHash: "b".repeat(64), prevTokenHash: "c".repeat(64),
        prevTokenExpires: new Date("2026-01-05T00:00:00Z"),
        claimToken: "d".repeat(64), claimExpires: new Date("2026-01-08T00:00:00Z"),
        rotatedAt: new Date("2026-01-04T12:00:00Z"),
        createdById: "u1", uploadedById: "u1",
      },
    });
    // A row that exists before its binary does — deviceId is null. This is the
    // "flash didn't complete" state, and it is the one with no natural key.
    await db.device.create({ data: { ...base, id: "d-building", name: "Kitchen", deviceId: null, status: "building", buildStatus: "building", tokenHash: null, claimToken: "e".repeat(64), createdById: "u1" } });

    ok((await db.device.count()) === 2, "two screens seeded");
    await db.$disconnect();
  }

  // ---- 4. sqlite -> postgres ---------------------------------------------
  const forward = await copyDatabase({
    sourceProvider: "sqlite", sourceUrl: `file:${SQLITE_A}`,
    targetProvider: "postgresql", targetUrl: PG_URL,
    prepareTarget: true,
  });
  ok(forward.ok, "sqlite -> postgres copy reports ok", forward.failedReason);
  const fwdReport = forward.tables.find((t) => t.model === "device");
  ok(Boolean(fwdReport), "the copy report INCLUDES device rather than skipping it");
  ok(fwdReport?.source === 2 && fwdReport?.target === 2 && fwdReport?.match === true,
     "both screens arrived in postgres and match", JSON.stringify(fwdReport));

  const fwdVerify = await verifyCopy({
    sourceProvider: "sqlite", sourceUrl: `file:${SQLITE_A}`,
    targetProvider: "postgresql", targetUrl: PG_URL,
  });
  ok(fwdVerify.ok, "sqlite -> postgres verifies every table", fwdVerify.failedReason);
  ok(fwdVerify.tables.some((t) => t.model === "device"), "verification INCLUDES device");

  // ---- 5. the awkward states survived, byte for byte ---------------------
  {
    const pg = await connectClient("postgresql", PG_URL);
    const mid = await pg.device.findUnique({ where: { id: "d-claimed" } });
    ok(Boolean(mid), "the rotating screen is present in postgres");
    ok(mid?.tokenHash === "b".repeat(64), "its live credential survived");
    ok(mid?.prevTokenHash === "c".repeat(64), "its GRACE credential survived — this is the row shape most likely to be dropped");
    ok(mid?.prevTokenExpires?.toISOString() === "2026-01-05T00:00:00.000Z", "the grace expiry survived to the second");
    ok(mid?.deviceId === "dev-claimed", "its deviceId survived");
    ok(mid?.createdById === "u1" && mid?.uploadedById === "u1", "its audit fields survived, still pointing at the user");

    const building = await pg.device.findUnique({ where: { id: "d-building" } });
    ok(building?.deviceId === null, "a row that exists before its binary kept deviceId NULL");
    ok(building?.tokenHash === null, "...and kept its NULL live credential");
    await pg.$disconnect();
  }

  // ---- 6. postgres -> sqlite, the direction the station came from --------
  const back = await copyDatabase({
    sourceProvider: "postgresql", sourceUrl: PG_URL,
    targetProvider: "sqlite", targetUrl: `file:${SQLITE_B}`,
    prepareTarget: true,
  });
  ok(back.ok, "postgres -> sqlite copy reports ok", back.failedReason);
  const backVerify = await verifyCopy({
    sourceProvider: "sqlite", sourceUrl: `file:${SQLITE_B}`,
    targetProvider: "postgresql", targetUrl: PG_URL,
  });
  ok(backVerify.ok, "the round trip verifies: postgres and sqlite agree", backVerify.failedReason);

  {
    const db = await connectClient("sqlite", `file:${SQLITE_B}`);
    const mid = await db.device.findUnique({ where: { id: "d-claimed" } });
    ok(mid?.prevTokenHash === "c".repeat(64), "the grace credential survived the round trip too");
    ok(mid?.lat === -42.8821 && mid?.lon === 147.3272, "latitude and longitude survived exactly — a float is a float");
    ok((await db.device.count()) === 2, "both screens are back");
    await db.$disconnect();
  }

  // ---- 7. SetNull: deleting the operator must not brick the wall -------
  {
    const db = await connectClient("sqlite", `file:${SQLITE_B}`);
    await db.user.delete({ where: { id: "u1" } });
    const orphan = await db.device.findUnique({ where: { id: "d-claimed" } });
    ok(Boolean(orphan), "the screen survived its operator being deleted");
    ok(orphan?.createdById === null, "and the audit field nulled rather than cascading the row away");
    ok(orphan?.tokenHash === "b".repeat(64), "and it kept working — a screen is not bound to a person");
    await db.$disconnect();
  }

  // ---- 8. the refusal that protects a cutover ---------------------------
  {
    const again = await copyDatabase({
      sourceProvider: "sqlite", sourceUrl: `file:${SQLITE_A}`,
      targetProvider: "postgresql", targetUrl: PG_URL,
    });
    ok(!again.ok, "a cutover into a populated database is refused");
    ok(/already holds/.test(again.failedReason || ""), "and says why", again.failedReason);
  }
} catch (e: any) {
  ok(false, "the cutover round trip ran", String(e?.message || e).split("\n")[0]);
} finally {
  if (containerUp) spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "pipe" });
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`  ${passed}/${passed + failed} device-cutover assertions passed`);
if (failed > 0) process.exit(1);