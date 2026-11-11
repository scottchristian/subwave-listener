// Shared-firmware OTA, at the level that matters: what actually happens.
//
// The static gates read this code. They cannot prove that a real ESP app image is
// accepted and a merged factory image is not, that the checksum walk agrees with
// esptool, that a second tap does not create a second attempt, that a report for
// an ended attempt cannot overwrite the one that replaced it, or that a screen
// can only ever fetch the release pinned by its own attempt.
//
// That last one is the security boundary, so it is exercised through the real
// route with a real bearer token — not by calling the service alone.
//
// HERMETIC. A scratch SQLite database and a scratch app root in the OS temp
// directory; the artifact files land under <tmp>/data/firmware and are removed
// with everything else. The migration history is applied to a SECOND empty
// database, so "the migration matches the schema" is proved rather than assumed.
//
// Run: npm run check:firmware-ota
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const SCHEMA = path.join(REPO, "prisma", ".gen-ota-test.prisma");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-ota-"));
const dbFile = path.join(tmp, "ota.db");
const migratedFile = path.join(tmp, "migrated.db");
const originalStatsDir = process.env.STATION_STATS_DIR;
process.env.STATION_STATS_DIR = path.join(tmp, "station-stats");

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";

// lib/firmware-upload resolves FIRMWARE_DIR from process.cwd(), so the artifact
// tree must be rooted in the throwaway directory before that module is imported.
process.chdir(tmp);

const cleanup = () => {
  if (originalStatsDir === undefined) delete process.env.STATION_STATS_DIR;
  else process.env.STATION_STATS_DIR = originalStatsDir;
  process.chdir(REPO);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SCHEMA, { force: true });
};

// ---------------------------------------------------------------------------
// Synthetic ESP app image
// ---------------------------------------------------------------------------

const HEADER = 24;
const DESC_MAGIC = 0xabcd5432;

function field(buf: Buffer, at: number, text: string, len: number) {
  buf.fill(0, at, at + len); // NUL-terminated, like the real descriptor
  buf.write(text.slice(0, len - 1), at, "latin1");
}

/**
 * Build a byte-exact app-only image: packed 24-byte header, one segment whose
 * first 256 bytes are the app descriptor, the 16-byte-aligned checksum block,
 * and the optional appended SHA-256. Options exist only to produce the malformed
 * variants the validator must refuse.
 */
function buildImage(
  o: {
    version?: string;
    project?: string;
    chipId?: number;
    dataLen?: number;
    hashAppended?: boolean;
    descMagic?: number;
    minRev?: number;
    maxRev?: number;
    magic?: number;
  } = {},
): { bytes: Buffer; checksumAt: number } {
  const version = o.version ?? "1.0.0";
  const project = o.project ?? "subwave-screen";
  const dataLen = o.dataLen ?? 272; // multiple of 4, room for the 256-byte descriptor
  if (dataLen % 4 !== 0 || dataLen < 256) throw new Error("bad test image geometry");

  const header = Buffer.alloc(HEADER);
  header[0] = o.magic ?? 0xe9;
  header[1] = 1;
  header.writeUInt16LE(o.chipId ?? 18, 0x0c);
  header.writeUInt16LE(o.minRev ?? 0, 0x0f);
  header.writeUInt16LE(o.maxRev ?? 300, 0x11);
  header[0x17] = (o.hashAppended ?? true) ? 1 : 0;

  const data = Buffer.alloc(dataLen);
  data.fill(0xa5);
  data.writeUInt32LE(o.descMagic ?? DESC_MAGIC, 0);
  field(data, 16, version, 32);
  field(data, 48, project, 32);
  field(data, 112, "v5.5.4", 32);

  const segHeader = Buffer.alloc(8);
  segHeader.writeUInt32LE(0x40000000, 0);
  segHeader.writeUInt32LE(data.length, 4);

  const segmentsEnd = HEADER + 8 + data.length;
  const block = ((segmentsEnd + 1 + 15) & ~15) - segmentsEnd;
  const tail = Buffer.alloc(block); // zero padding, checksum in the LAST byte
  const checksumAt = segmentsEnd + block - 1;

  let checksum = 0xef;
  for (const byte of data) checksum ^= byte;
  tail[block - 1] = checksum & 0xff;

  const body = Buffer.concat([header, segHeader, data, tail]);
  if (o.hashAppended ?? true) {
    return { bytes: Buffer.concat([body, createHash("sha256").update(body).digest()]), checksumAt };
  }
  return { bytes: body, checksumAt };
}

/** The OtaError code a call throws, or "no-throw". */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return (e as { code?: string })?.code ?? String(e);
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no-throw";
  } catch (e) {
    return (e as { code?: string })?.code ?? String(e);
  }
}

try {
  execFileSync("node", ["scripts/gen-schema.mjs", "sqlite", SCHEMA], { cwd: REPO, stdio: "pipe" });
  execFileSync("npx", ["prisma", "db", "push", "--schema", SCHEMA, "--skip-generate"], {
    cwd: REPO,
    stdio: "pipe",
    env: { ...process.env },
  });
  ok(fs.existsSync(dbFile), "a scratch database was built from the current schema");

  // ---- the migration applies to an empty database -----------------------
  // Not db push: this runs the SQL an operator's deploy would run, in order.
  {
    let applied = false;
    try {
      execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", SCHEMA], {
        cwd: REPO,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: `file:${migratedFile}` },
      });
      applied = fs.existsSync(migratedFile);
    } catch {
      applied = false;
    }
    ok(applied, "the migrations apply cleanly to an empty database");

    // Prove the new columns/table are what the migration actually created, by
    // asking SQLite for them (a missing table or column is an error).
    let columns = false;
    try {
      execFileSync(
        "npx",
        ["prisma", "db", "execute", "--schema", SCHEMA, "--stdin"],
        {
          cwd: REPO,
          stdio: "pipe",
          input:
            'SELECT "activeDeviceId", "requestId", "phase", "bootResult" FROM "DeviceOtaAttempt" LIMIT 1;\n' +
            'SELECT "otaCapable", "otaInstalledVersion", "otaInstalledSlot" FROM "Device" LIMIT 1;\n' +
            'SELECT "publishedAt", "withdrawnAt", "sha256" FROM "FirmwareRelease" LIMIT 1;\n',
          env: { ...process.env, DATABASE_URL: `file:${migratedFile}` },
        },
      );
      columns = true;
    } catch {
      columns = false;
    }
    ok(columns, "and the OTA table and columns exist after the migration, not only after db push");
  }

  const prisma = (await import("../lib/prisma.ts")).default;
  const auth = await import("../lib/device-auth.ts");
  const ota = await import("../lib/firmware-ota.ts");

  // ---- image validation --------------------------------------------------
  {
    const good = buildImage();
    const parsed = ota.parseEspAppImage(good.bytes);
    ok(parsed.sizeBytes === good.bytes.length, "a valid image is accepted at its real size");
    ok(parsed.sha256 === createHash("sha256").update(good.bytes).digest("hex"), "its sha256 covers every byte");
    ok(parsed.chipId === 18, "the chip is read from the header");
    ok(parsed.descriptor.version === "1.0.0", "the descriptor version is read");
    ok(parsed.descriptor.project === "subwave-screen", "the descriptor project is read");
    ok(parsed.hashAppended, "the appended digest is recognised");

    const noHash = buildImage({ hashAppended: false });
    ok(ota.parseEspAppImage(noHash.bytes).sizeBytes === noHash.bytes.length, "an image without an appended digest is valid");

    ok(codeOf(() => ota.parseEspAppImage(good.bytes.subarray(0, 100))) === "truncated", "a short file is truncated");
    ok(codeOf(() => ota.parseEspAppImage(Buffer.alloc(ota.APP_SLOT_BYTES + 1, 0xe9))) === "oversized", "a file over the app slot is refused");

    const merged = Buffer.alloc(400, 0xff);
    ok(codeOf(() => ota.parseEspAppImage(merged)) === "not_app_image", "a merged factory image is refused");
    ok(codeOf(() => ota.parseEspAppImage(buildImage({ chipId: 13 }).bytes)) === "wrong_chip", "another chip's image is refused");
    ok(codeOf(() => ota.parseEspAppImage(buildImage({ descMagic: 0x12345678 }).bytes)) === "bad_descriptor", "a missing descriptor is refused");
    ok(codeOf(() => ota.parseEspAppImage(buildImage({ project: "other-project" }).bytes)) === "wrong_project", "another project's image is refused");
    ok(codeOf(() => ota.parseEspAppImage(buildImage({ version: "not-a-version" }).bytes)) === "bad_descriptor", "an unorderable descriptor version is refused");

    const badChecksum = Buffer.from(good.bytes);
    badChecksum[good.checksumAt] ^= 0xff;
    ok(codeOf(() => ota.parseEspAppImage(badChecksum)) === "bad_checksum", "a corrupted checksum is refused");

    const badHash = Buffer.from(good.bytes);
    badHash[badHash.length - 1] ^= 0xff;
    ok(codeOf(() => ota.parseEspAppImage(badHash)) === "bad_hash", "a corrupted appended digest is refused");

    const trailing = Buffer.concat([noHash.bytes, Buffer.from([1, 2, 3, 4])]);
    ok(codeOf(() => ota.parseEspAppImage(trailing)) === "trailing_data", "bytes after the image are refused rather than ignored");

    const truncatedInside = buildImage({ dataLen: 300 }).bytes.subarray(0, 200);
    ok(codeOf(() => ota.parseEspAppImage(truncatedInside)) === "truncated", "an image cut inside a segment is truncated");
  }

  // ---- versions are numbers ---------------------------------------------
  {
    ok(ota.compareReleaseVersions("1.10.0", "1.9.0") === 1, "1.10.0 is newer than 1.9.0, as numbers");
    ok(ota.compareReleaseVersions("1.2.0", "1.02.0") === 0, "1.2.0 and 1.02.0 are the same version");
    ok(ota.compareReleaseVersions("1.0.0", "1.0.0-beta.1") === 1, "a release is newer than its prerelease");
  }

  // ---- the running-image block is parsed defensively ---------------------
  {
    const good = ota.parseInstalledInfo({ version: "1.15.0", sha256: "A".repeat(64), slot: "app0" });
    ok(good?.sha256 === "a".repeat(64), "a reported sha256 is lowercased before comparison");
    ok(good?.slot === "app0", "a known slot is kept");
    ok(ota.parseInstalledInfo({ version: "nope", sha256: "short", slot: "app2" })?.version === null,
      "an unorderable version is discarded rather than trusted");
    ok(ota.parseInstalledInfo({ version: "1.15.0", sha256: "short" })?.sha256 === null,
      "a sha256 that is not 64 hex characters is discarded");
    ok(ota.parseInstalledInfo({ version: "1.15.0", sha256: "a".repeat(64), slot: "app2" })?.slot === null,
      "a slot outside app0/app1 is discarded");
    ok(ota.parseInstalledInfo(null) === null, "no block parses to null");
    ok(ota.parseInstalledInfo("installed") === null, "a string is not a block");
  }

  const v1Image = buildImage({ version: "1.0.0" }).bytes;
  const v1AltImage = buildImage({ version: "1.0.0", dataLen: 276 }).bytes;
  const v2Image = buildImage({ version: "1.1.0", dataLen: 280 }).bytes;

  // ---- registration is immutable and idempotent --------------------------
  let rel1: Awaited<ReturnType<typeof ota.registerSharedRelease>> | null = null;
  let rel2: Awaited<ReturnType<typeof ota.registerSharedRelease>> | null = null;
  {
    rel1 = await ota.registerSharedRelease({ bytes: v1Image, version: "1.0.0", filename: "../../evil name.bin", uploadedById: null });
    ok(rel1.created === true, "the first upload creates a release");
    ok(rel1.release.sizeBytes === v1Image.length, "the release records the real size");
    ok(rel1.release.sha256 === createHash("sha256").update(v1Image).digest("hex"), "and the sha256 of the bytes");
    ok(rel1.release.filename === "evil name.bin", "a filename is reduced to its basename");

    const artifact = path.join(tmp, "data", "firmware", "ota", "artifacts", `${rel1.release.sha256}.bin`);
    ok(fs.existsSync(artifact), "and the artifact is stored under its hash");

    const same = await ota.registerSharedRelease({ bytes: v1Image, version: "1.0.0", filename: "again.bin", uploadedById: null });
    ok(same.created === false && same.release.id === rel1.release.id, "re-uploading the same bytes is idempotent");

    ok(
      (await asyncCodeOf(() =>
        ota.registerSharedRelease({ bytes: v1AltImage, version: "1.0.0", filename: "x.bin", uploadedById: null }),
      )) === "duplicate_version",
      "different bytes under an existing version are refused",
    );
    ok(
      (await asyncCodeOf(() =>
        ota.registerSharedRelease({
          bytes: buildImage({ version: "01.0.0" }).bytes,
          version: "01.0.0",
          filename: "x.bin",
          uploadedById: null,
        }),
      )) === "duplicate_version",
      "and so is the same version written with a leading zero",
    );
    ok(
      (await asyncCodeOf(() =>
        ota.registerSharedRelease({ bytes: buildImage({ version: "1.2.0" }).bytes, version: "1.3.0", filename: "x.bin", uploadedById: null }),
      )) === "descriptor_version_mismatch",
      "declared version must match the descriptor's own version",
    );

    rel2 = await ota.registerSharedRelease({ bytes: v2Image, version: "1.1.0", filename: "firmware.ota.bin", uploadedById: null });
    ok(rel2.created === true && rel2.release.version === "1.1.0", "a newer version registers separately");
  }

  // ---- publish / withdraw ------------------------------------------------
  {
    ok((await ota.getPublishedRelease()) === null, "nothing is offered before anything is published");
    const published1 = await ota.publishRelease(rel1!.release.id);
    ok(published1.publishedAt !== null, "publishing stamps the release");
    ok((await ota.getPublishedRelease())?.id === rel1!.release.id, "and moves the published pointer");

    const published2 = await ota.publishRelease(rel2!.release.id);
    ok(published2.id === rel2!.release.id, "publishing a newer release replaces the pointer");
    ok((await ota.getPublishedRelease())?.version === "1.1.0", "screens now see 1.1.0");

    await ota.withdrawRelease(rel2!.release.id);
    ok((await ota.getPublishedRelease()) === null, "withdrawing the published release leaves no offer");
    ok(
      fs.existsSync(path.join(tmp, "data", "firmware", "ota", "artifacts", `${rel2!.release.sha256}.bin`)),
      "but its artifact is kept, because an install may still be pinned to it",
    );
    await ota.publishRelease(rel1!.release.id);
  }

  // ---- devices -----------------------------------------------------------
  let seq = 0;
  const tokens = new Map<string, string>();
  const mkDevice = async (over: Record<string, unknown> = {}) => {
    seq++;
    const raw = `test-device-token-${seq}-${"x".repeat(20)}`;
    const row = await prisma.device.create({
      data: {
        name: `Screen ${seq}`,
        model: "jc8012p4a1",
        status: "active",
        buildStatus: "built",
        settingsRev: 1,
        orientation: "landscape",
        themeMode: "auto",
        brightness: 70,
        idleMode: "dim",
        idleMin: 15,
        idlePct: 20,
        skipEnabled: "1",
        rotateViews: "0",
        timezone: "Australia/Hobart",
        lat: -42.8821,
        lon: 147.3272,
        tokenHash: auth.hashToken(raw),
        ...over,
      },
    });
    tokens.set(row.id, raw);
    return row;
  };
  const heartbeat = (row: { id: string; tokenHash: string | null; deviceId: string | null; status: string; otaCapable?: boolean }, o?: unknown, viaRotation = false) =>
    ota.handleOtaHeartbeat({ row: row as any, ota: o, viaRotation });
  const attemptCount = (deviceId: string) => prisma.deviceOtaAttempt.count({ where: { deviceId } });
  const liveAttempt = (deviceId: string) => prisma.deviceOtaAttempt.findFirst({ where: { activeDeviceId: deviceId } });

  const d1 = await mkDevice();
  const d2 = await mkDevice();
  const d3 = await mkDevice();

  // ---- discovery creates nothing; an explicit tap creates exactly one -----
  {
    const before = await attemptCount(d1.id);
    const seen = await heartbeat(d1, { capable: true });
    ok(seen.response?.published?.version === "1.0.0", "an availability check reports the published release");
    ok(seen.patch.otaCapable === true, "and marks the screen OTA-capable");
    ok((await attemptCount(d1.id)) === before, "looking at an update creates no attempt");

    const requested = await heartbeat(d1, {
      capable: true,
      request: { requestId: "req_d1_0001", releaseId: rel1!.release.id },
    });
    ok(requested.response?.attempt?.state === "accepted", "an explicit request is accepted");
    ok(requested.response?.attempt?.downloadUrl === "/api/devices/ota", "and offers the fixed stream path");
    const a1 = requested.response!.attempt!.id;

    const replay = await heartbeat(d1, {
      capable: true,
      request: { requestId: "req_d1_0001", releaseId: rel1!.release.id },
    });
    ok(replay.response?.attempt?.id === a1, "a lost response replayed with the same request id returns the same attempt");
    ok((await attemptCount(d1.id)) === 1, "and creates no second row");

    const secondTap = await heartbeat(d1, {
      capable: true,
      request: { requestId: "req_d1_0002", releaseId: rel1!.release.id },
    });
    ok(secondTap.response?.attempt?.id === a1, "a second tap while installing reports the running attempt");
    ok(secondTap.response?.notice === "already_in_progress", "with a reason, not a silent no-op");
    ok((await attemptCount(d1.id)) === 1, "and does not consume a second attempt");

    // The database, not just the service, enforces one active attempt per device.
    const duplicateReservation = await asyncCodeOf(() =>
      prisma.deviceOtaAttempt.create({
        data: {
          requestId: "req_direct_01",
          deviceId: d1.id,
          releaseId: rel1!.release.id,
          phase: "accepted",
          activeDeviceId: d1.id,
        },
      }),
    );
    ok(duplicateReservation === "P2002", "the unique reservation refuses a second active attempt at the database level");

    // Cross-device: another screen cannot move this attempt.
    const foreign = await heartbeat(d2, { capable: true, report: { attemptId: a1, phase: "installing" } });
    ok(foreign.response?.notice === "stale_report", "a report for another screen's attempt is stale");
    ok((await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a1 } })).phase === "accepted", "and changes nothing");

    // Forward only, through every phase a real download goes through.
    const same = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "accepted" } });
    ok(same.response?.attempt?.state === "accepted", "repeating the current phase is idempotent");
    const downloading = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "downloading" } });
    ok(downloading.response?.attempt?.state === "downloading", "downloading is a forward move");
    const verifying = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "verifying" } });
    ok(verifying.response?.attempt?.state === "verifying", "verifying is a forward move");
    const installing = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "installing" } });
    ok(installing.response?.attempt?.state === "installing", "installing is a forward move");
    const backwards = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "downloading" } });
    ok(backwards.response?.notice === "stale_report", "a backwards report is stale");
    ok(backwards.response?.attempt?.state === "installing", "and the later phase stands");

    // A phase the device may not assert is refused outright.
    const invented = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "unknown" } });
    ok(invented.response?.notice === "bad_report", "a device cannot declare its own attempt unknown");
    const serverOnly = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "rejected" } });
    ok(serverOnly.response?.notice === "bad_report", "nor rejected — those are server decisions");

    const rebooting = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "rebooting" } });
    ok(rebooting.response?.attempt?.state === "rebooting", "rebooting is recorded");
    await heartbeat(d1, { capable: true });
    ok(
      (await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a1 } })).phase === "rebooting",
      "silence after a reboot stays unknown instead of being guessed",
    );

    const unproven = await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "succeeded" } });
    ok(unproven.response?.notice === "bad_report", "success without a boot result is refused");
    ok((await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a1 } })).phase === "rebooting", "and changes nothing");

    // A boot claim with no running-image block is not proof either. It is not a
    // failure yet, because the next heartbeat may carry one.
    const unproved = await heartbeat(d1, {
      capable: true,
      report: { attemptId: a1, phase: "succeeded", bootResult: "ok" },
    });
    ok(unproved.response?.notice === "installed_not_reported", "a boot claim without the running image is not success");
    ok((await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a1 } })).phase === "rebooting", "and the attempt stays open for the next heartbeat");

    const succeeded = await heartbeat(d1, {
      capable: true,
      // The running image is a sibling of the report, not part of it: it is a
      // fact about the screen, while the report is a claim about the install.
      installed: { version: "1.0.0", sha256: rel1!.release.sha256, slot: "app1" },
      report: {
        attemptId: a1,
        phase: "succeeded",
        bootResult: "ok",
      },
    });
    ok(succeeded.response?.attempt?.state === "succeeded", "a confirmed boot of the pinned image ends the attempt");
    ok(succeeded.response?.attempt?.downloadUrl === null, "and a finished attempt offers no download");
    const d1After = await prisma.device.findUniqueOrThrow({ where: { id: d1.id } });
    ok(d1After.otaInstalledVersion === "1.0.0", "and becomes the running-image fact");
    ok(d1After.otaInstalledSha === rel1!.release.sha256, "with the sha256 that was actually served");
    ok(d1After.otaInstalledSlot === "app1", "and the slot the screen booted from");
    ok((await liveAttempt(d1.id)) === null, "the reservation is released");
    ok(
      (await heartbeat(d1, { capable: true, report: { attemptId: a1, phase: "installing" } })).response?.notice === "stale_report",
      "a late report for the ended attempt cannot reopen it",
    );

    // The canonical release values are stored, not whatever spelling the screen
    // used, and the write is conditional on the screen still existing.
    const replayAfterSuccess = await heartbeat(d1, {
      capable: true,
      report: { attemptId: a1, phase: "succeeded", bootResult: "ok" },
    });
    ok(replayAfterSuccess.response?.notice === "stale_report", "a replayed success after the attempt ended is stale, not re-applied");
  }

  // ---- success is proved by the running image ----------------------------
  {
    await ota.publishRelease(rel1!.release.id);
    const d = await mkDevice();
    const accepted = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_mismatch_01", releaseId: rel1!.release.id },
    });
    const id = accepted.response!.attempt!.id;
    await heartbeat(d, { capable: true, report: { attemptId: id, phase: "rebooting" } });

    const wrongVersion = await heartbeat(d, {
      capable: true,
      installed: { version: "9.9.9", sha256: rel1!.release.sha256, slot: "app0" },
      report: {
        attemptId: id,
        phase: "succeeded",
        bootResult: "ok",
      },
    });
    ok(wrongVersion.response?.attempt?.state === "failed", "a boot of a different version is not success");
    ok(wrongVersion.response?.notice === "success_mismatch", "and the panel is told why");
    const mismatched = await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id } });
    ok(mismatched.errorCode === "success_mismatch", "with a bounded error code on the row");
    ok((await prisma.device.findUniqueOrThrow({ where: { id: d.id } })).otaInstalledVersion === null,
      "and no running-image fact is invented from an unproved claim");

    const d2 = await mkDevice();
    const second = await heartbeat(d2, {
      capable: true,
      request: { requestId: "req_mismatch_02", releaseId: rel1!.release.id },
    });
    const id2 = second.response!.attempt!.id;
    await heartbeat(d2, { capable: true, report: { attemptId: id2, phase: "rebooting" } });
    const wrongHash = await heartbeat(d2, {
      capable: true,
      installed: { version: "1.0.0", sha256: "0".repeat(64), slot: "app0" },
      report: {
        attemptId: id2,
        phase: "succeeded",
        bootResult: "ok",
      },
    });
    ok(wrongHash.response?.attempt?.state === "failed", "the same version with different bytes is not success either");
    ok(wrongHash.response?.notice === "success_mismatch", "and says so");
  }

  // ---- an idle screen's running image is recorded, not guessed -----------
  {
    const d = await mkDevice();
    const idle = await heartbeat(d, {
      capable: true,
      installed: { version: "1.1.0", sha256: rel2!.release.sha256, slot: "app0" },
    });
    ok(idle.response?.attempt === null, "an idle screen has no attempt");
    ok(idle.patch.otaInstalledVersion === "1.1.0", "its reported version becomes the running-image fact");
    ok(idle.patch.otaInstalledSha === rel2!.release.sha256, "and its sha256");
    ok(idle.patch.otaInstalledSlot === "app0", "and the slot it booted from");

    // But not while an install is live: that would overwrite the target's record
    // with the image the screen is about to replace.
    await ota.publishRelease(rel1!.release.id);
    const busy = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_idle_0001", releaseId: rel1!.release.id },
      installed: { version: "1.1.0", sha256: rel2!.release.sha256, slot: "app0" },
    });
    ok(busy.response?.attempt?.state === "accepted", "the idle screen can still be asked to install");
    ok(!("otaInstalledVersion" in busy.patch), "but its old running image is not written over a live attempt");
  }

  // ---- silence ages into unknown, and the screen can retry ---------------
  {
    await ota.publishRelease(rel1!.release.id);
    const d = await mkDevice();
    const accepted = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_silent_01", releaseId: rel1!.release.id },
    });
    const id = accepted.response!.attempt!.id;
    await heartbeat(d, { capable: true, report: { attemptId: id, phase: "rebooting" } });

    // No report inside the reboot window: still live, still unknown.
    ok((await ota.reconcileStaleAttempts(d.id)) === 0, "an attempt inside its silence window is left alone");

    await prisma.deviceOtaAttempt.update({
      where: { id },
      data: { updatedAt: new Date(Date.now() - ota.REBOOT_SILENCE_MS - 1000) },
    });
    ok((await ota.reconcileStaleAttempts(d.id)) === 1, "an attempt silent past the reboot window is reaped");
    const reaped = await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id } });
    ok(reaped.phase === "unknown", "and becomes unknown, not failed and not succeeded");
    ok(reaped.activeDeviceId === null, "releasing the reservation");
    ok(reaped.errorCode === "silence_after_reboot", "with a reason the panel can show");
    ok(reaped.finishedAt !== null, "and an end time");

    const late = await heartbeat(d, {
      capable: true,
      report: { attemptId: id, phase: "succeeded", bootResult: "ok" },
    });
    ok(late.response?.notice === "stale_report", "a report after the reap cannot resurrect it");

    const retry = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_silent_02", releaseId: rel1!.release.id },
    });
    ok(retry.response?.attempt?.state === "accepted", "and the screen can start a fresh attempt");

    // The install window is separate and longer than the reboot one.
    const stalled = await mkDevice();
    const second = await heartbeat(stalled, {
      capable: true,
      request: { requestId: "req_silent_03", releaseId: rel1!.release.id },
    });
    const id2 = second.response!.attempt!.id;
    await heartbeat(stalled, { capable: true, report: { attemptId: id2, phase: "downloading" } });
    await prisma.deviceOtaAttempt.update({
      where: { id: id2 },
      data: { updatedAt: new Date(Date.now() - ota.INSTALL_SILENCE_MS - 1000) },
    });
    await ota.reconcileStaleAttempts(stalled.id);
    const stalledRow = await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: id2 } });
    ok(stalledRow.phase === "unknown" && stalledRow.errorCode === "silence_during_install", "a download that stops reporting also ages to unknown");
  }

  // ---- an operator can end a live attempt --------------------------------
  {
    await ota.publishRelease(rel1!.release.id);
    const d = await mkDevice();
    const accepted = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_cancel_01", releaseId: rel1!.release.id },
    });
    const id = accepted.response!.attempt!.id;

    const cancelled = await ota.cancelAttempt(id);
    ok(cancelled.state === "failed", "cancelling ends the attempt as failed");
    ok(cancelled.downloadUrl === null, "and stops offering bytes");
    const row = await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id } });
    ok(row.errorCode === "cancelled_by_operator", "with the operator as the cause");
    ok((await liveAttempt(d.id)) === null, "the reservation is released");

    const again = await asyncCodeOf(() => ota.cancelAttempt(id));
    ok(again === "no_active_attempt", "cancelling an ended attempt is refused rather than rewriting history");

    const retry = await heartbeat(d, {
      capable: true,
      request: { requestId: "req_cancel_02", releaseId: rel1!.release.id },
    });
    ok(retry.response?.attempt?.state === "accepted", "and the screen is free to try again");
  }

  // ---- publication changed under the operator ----------------------------
  {
    await ota.publishRelease(rel2!.release.id); // now 1.1.0, while the screen saw 1.0.0
    const changed = await heartbeat(d3, {
      capable: true,
      request: { requestId: "req_d3_0001", releaseId: rel1!.release.id },
    });
    ok(changed.response?.notice === "publication_changed", "a request for the old offer is refused, not silently honoured");
    ok(changed.response?.attempt?.state === "rejected", "and the refusal is recorded");
    ok((await liveAttempt(d3.id)) === null, "no install is reserved");

    const again = await heartbeat(d3, {
      capable: true,
      request: { requestId: "req_d3_0001", releaseId: rel1!.release.id },
    });
    ok(again.response?.attempt?.id === changed.response?.attempt?.id, "retrying the same request id is idempotent");
    ok(again.response?.notice === "publication_changed", "and still says why");
    ok((await attemptCount(d3.id)) === 1, "with one row, not two");

    const freshTap = await heartbeat(d3, {
      capable: true,
      request: { requestId: "req_d3_0002", releaseId: rel2!.release.id },
    });
    ok(freshTap.response?.attempt?.state === "accepted", "a new explicit tap installs the current offer");
  }

  // ---- withdrawal while pinned ------------------------------------------
  {
    await ota.withdrawRelease(rel2!.release.id);
    ok((await ota.getPublishedRelease()) === null, "withdrawal leaves nothing on offer");

    const pinned = await ota.readActiveArtifact(d3 as any);
    ok(pinned.ok === true, "a screen already installing the withdrawn release can still fetch it");
    if (pinned.ok) {
      ok(pinned.release.version === "1.1.0", "the pinned version is served, not the pointer");
      ok(pinned.bytes.equals(Buffer.from(v2Image)), "and the exact bytes");
    }

    const d5 = await mkDevice();
    const late = await heartbeat(d5, {
      capable: true,
      request: { requestId: "req_d5_0001", releaseId: rel2!.release.id },
    });
    ok(late.response?.notice === "publication_changed", "a new request for a withdrawn release is refused");

    const d3Attempt = await prisma.deviceOtaAttempt.findFirstOrThrow({ where: { activeDeviceId: d3.id } });
    const stillInstalling = await heartbeat(d3, { capable: true, report: { attemptId: d3Attempt.id, phase: "installing" } });
    ok(stillInstalling.response?.attempt?.state === "installing", "and the pinned install can finish after withdrawal");
  }

  // ---- a newer publication does not move a pinned install ----------------
  {
    await ota.publishRelease(rel1!.release.id);
    const d6 = await mkDevice();
    const accepted = await heartbeat(d6, {
      capable: true,
      request: { requestId: "req_d6_0001", releaseId: rel1!.release.id },
    });
    ok(accepted.response?.attempt?.state === "accepted", "the older release is accepted while it is the offer");

    await ota.publishRelease(rel2!.release.id);
    const pinned = await ota.readActiveArtifact(d6 as any);
    ok(pinned.ok === true && pinned.release.version === "1.0.0", "publishing newer does not repoint an in-flight install");
    if (pinned.ok) ok(pinned.bytes.equals(Buffer.from(v1Image)), "the pinned install still gets its own bytes");

    // ---- the stream, through the real route -----------------------------
    const { NextRequest } = await import("next/server.js");
    const stream = await import("../app/api/devices/ota/route.ts");

    const authed = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", {
        headers: { authorization: `Bearer ${tokens.get(d6.id)}` },
      }),
    );
    ok(authed.status === 200, "the authenticated stream answers 200");
    ok(authed.headers.get("content-type") === "application/octet-stream", "as an octet stream");
    ok(authed.headers.get("cache-control") === "no-store", "never cached");
    ok(authed.headers.get("content-length") === String(v1Image.length), "with an exact byte count");
    ok(authed.headers.get("x-firmware-version") === "1.0.0", "and the pinned version in a header");
    ok(authed.headers.get("x-firmware-sha256") === rel1!.release.sha256, "and the pinned sha256");
    ok(Buffer.from(await authed.arrayBuffer()).equals(Buffer.from(v1Image)), "the body is exactly the stored artifact");

    // d3 is pinned to 1.1.0; it must never receive d6's 1.0.0.
    const other = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", {
        headers: { authorization: `Bearer ${tokens.get(d3.id)}` },
      }),
    );
    ok(other.status === 200, "the other screen may fetch its own attempt");
    ok(other.headers.get("x-firmware-version") === "1.1.0", "but only the release its own attempt pinned");

    const anonymous = await stream.GET(new NextRequest("http://localhost/api/devices/ota"));
    ok(anonymous.status === 401, "no token is refused");

    const query = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota?release=anything", {
        headers: { authorization: `Bearer ${tokens.get(d6.id)}` },
      }),
    );
    ok(query.status === 400, "a query string is refused — there is nothing to choose");

    const idle = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", {
        headers: { authorization: `Bearer ${tokens.get(d1.id)}` },
      }),
    );
    ok(idle.status === 409, "a screen with no live attempt gets no bytes");

    const finished = await heartbeat(d6, {
      capable: true,
      installed: { version: "1.0.0", sha256: rel1!.release.sha256, slot: "app0" },
      report: {
        attemptId: accepted.response!.attempt!.id,
        phase: "succeeded",
        bootResult: "ok",
      },
    });
    ok(finished.response?.attempt?.state === "succeeded", "an install pinned to the older release can finish after a newer one is published");
    ok(
      (await prisma.device.findUniqueOrThrow({ where: { id: d6.id } })).otaInstalledVersion === "1.0.0",
      "and the running-image fact is the release it actually booted, not the newest offer",
    );
  }

  // ---- revocation --------------------------------------------------------
  {
    const d7 = await mkDevice();
    await ota.publishRelease(rel1!.release.id);
    const accepted = await heartbeat(d7, {
      capable: true,
      request: { requestId: "req_d7_0001", releaseId: rel1!.release.id },
    });
    const a7 = accepted.response!.attempt!.id;

    // Revoke the row exactly as the admin route does.
    await prisma.device.update({
      where: { id: d7.id },
      data: { status: "revoked", tokenHash: null, prevTokenHash: null, prevTokenExpires: null },
    });
    const revokedRow = await prisma.device.findUniqueOrThrow({ where: { id: d7.id } });

    const report = await heartbeat(revokedRow, { capable: true, report: { attemptId: a7, phase: "installing" } });
    ok(report.response?.notice === "device_revoked", "a revoked screen cannot move its attempt");
    ok((await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a7 } })).phase === "accepted", "and the phase is untouched");
    const afterRevoke = await prisma.device.findUniqueOrThrow({ where: { id: d7.id } });
    ok(afterRevoke.status === "revoked", "a lifecycle update never reactivates a revoked device");

    const request = await heartbeat(revokedRow, {
      capable: true,
      request: { requestId: "req_d7_0002", releaseId: rel1!.release.id },
    });
    ok(request.response?.notice === "device_revoked", "and it cannot start a new attempt");
    ok((await ota.readActiveArtifact(revokedRow as any)).ok === false, "nor download the one it already has");

    const { NextRequest } = await import("next/server.js");
    const stream = await import("../app/api/devices/ota/route.ts");
    const res = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", {
        headers: { authorization: `Bearer ${tokens.get(d7.id)}` },
      }),
    );
    ok(res.status === 401, "the stream refuses a revoked screen's token");
  }

  // ---- rotation and an install are mutually exclusive -------------------
  {
    const d8 = await mkDevice();
    const accepted = await heartbeat(d8, {
      capable: true,
      request: { requestId: "req_d8_0001", releaseId: rel1!.release.id },
    });
    ok(accepted.response?.attempt?.state === "accepted", "a screen mid-install is accepted");

    const blocked = await (async () => {
      try {
        await auth.beginRotation(await prisma.device.findUniqueOrThrow({ where: { id: d8.id } }));
        return null;
      } catch (e) {
        return e as { name: string; status: number };
      }
    })();
    ok(blocked?.status === 409, "rotating the credential of a screen mid-install is refused");
    const d8After = await prisma.device.findUniqueOrThrow({ where: { id: d8.id } });
    ok(d8After.tokenHash !== null, "and the live credential is left alone");

    const d9 = await mkDevice();
    await auth.beginRotation(await prisma.device.findUniqueOrThrow({ where: { id: d9.id } }));
    const rotatingRow = await prisma.device.findUniqueOrThrow({ where: { id: d9.id } });
    ok(rotatingRow.tokenHash === null, "a rotation with no install in flight proceeds");

    const during = await heartbeat(rotatingRow, {
      capable: true,
      request: { requestId: "req_d9_0001", releaseId: rel1!.release.id },
    }, true);
    ok(during.response?.notice === "rotation_in_progress", "an install requested over a grace token waits");
    ok((await attemptCount(d9.id)) === 0, "and creates nothing");
    ok(
      (await ota.requestOtaInstall(rotatingRow as any, { requestId: "req_d9_0002", releaseId: rel1!.release.id })).notice ===
        "rotation_in_progress",
      "the service refuses it too, not only the route wiring",
    );

    // The real hazard on Postgres READ COMMITTED: a rotation and an install
    // arriving together. Both take the Device row write lock, so exactly one can
    // commit its decision and the other must see it.
    const racer = await mkDevice();
    const racing = await prisma.device.findUniqueOrThrow({ where: { id: racer.id } });
    const [rotated, installed] = await Promise.all([
      auth.beginRotation(racing).then(() => "rotated").catch((e: any) => `refused_${e?.status ?? "err"}`),
      ota.requestOtaInstall(racing, { requestId: "req_race_0001", releaseId: rel1!.release.id }),
    ]);
    const rotationWon = rotated === "rotated";
    ok(
      (rotationWon && installed.notice === "rotation_in_progress" && installed.attempt === null) ||
        (!rotationWon && rotated === "refused_409" && installed.attempt?.state === "accepted"),
      "a rotation and an install that race resolve to exactly one winner",
      `rotation=${rotated} install=${installed.attempt?.state ?? installed.notice}`,
    );
    const raceRow = await prisma.device.findUniqueOrThrow({ where: { id: racer.id } });
    const raceLive = await liveAttempt(racer.id);
    ok(
      rotationWon ? raceRow.tokenHash === null && raceLive === null : raceRow.tokenHash !== null && raceLive !== null,
      "and the database agrees with the winner",
    );
  }

  // ---- firmware that does not speak OTA ---------------------------------
  {
    const d10 = await mkDevice();
    const silent = await heartbeat(await prisma.device.findUniqueOrThrow({ where: { id: d10.id } }));
    ok(silent.response === null, "a heartbeat with no ota object gets no ota response");
    ok(Object.keys(silent.patch).length === 0, "and no device patch");
    ok((await attemptCount(d10.id)) === 0, "and nothing is created for it");

    const { NextRequest } = await import("next/server.js");
    const route = await import("../app/api/devices/heartbeat/route.ts");
    const res = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(d10.id)}` },
        body: JSON.stringify({ firmwareVer: "0.9.0", appliedRev: 1 }),
      }),
    );
    const body = await res.json();
    ok(res.status === 200, "an old firmware heartbeat still succeeds");
    ok(!("ota" in body), "with no ota key to confuse it");
  }

  // ---- the heartbeat route wires request -> stream ----------------------
  {
    const d11 = await mkDevice();
    await ota.publishRelease(rel1!.release.id);
    const { NextRequest } = await import("next/server.js");
    const route = await import("../app/api/devices/heartbeat/route.ts");
    const stream = await import("../app/api/devices/ota/route.ts");

    const res = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(d11.id)}` },
        body: JSON.stringify({
          firmwareVer: "1.0.0",
          ota: { capable: true, request: { requestId: "req_route_01", releaseId: rel1!.release.id } },
        }),
      }),
    );
    const body = await res.json();
    ok(res.status === 200 && body.ota?.attempt?.state === "accepted", "a heartbeat request is accepted end to end");
    ok(body.ota?.published?.version === "1.0.0", "and the same response carries the offer");

    const download = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", {
        headers: { authorization: `Bearer ${tokens.get(d11.id)}` },
      }),
    );
    ok(download.status === 200, "the accepted screen can download over the same credential");
    ok(
      Buffer.from(await download.arrayBuffer()).equals(Buffer.from(v1Image)),
      "and receives the release its attempt pinned",
    );

    const moved = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(d11.id)}` },
        body: JSON.stringify({
          ota: { capable: true, report: { attemptId: body.ota.attempt.id, phase: "installing" } },
        }),
      }),
    );
    const movedBody = await moved.json();
    ok(moved.status === 200 && movedBody.ota?.attempt?.state === "installing", "a report carried by the same heartbeat moves it");
  }
  // ---- hostile input and the edges of each window -----------------------
  {
    const { NextRequest } = await import("next/server.js");
    const route = await import("../app/api/devices/heartbeat/route.ts");
    const stream = await import("../app/api/devices/ota/route.ts");

    // A malformed request is a bounded refusal, never a 500 and never a row.
    const d12 = await mkDevice();
    const before12 = await attemptCount(d12.id);
    const badRequests: [string, string, string][] = [
      ["too short", "short", rel1!.release.id],
      ["an illegal character", "req_bad_0001!", rel1!.release.id],
      ["an empty id", "", rel1!.release.id],
      ["an over-long id", "r".repeat(65), rel1!.release.id],
      ["an illegal release id", "req_d12_0001", "not a valid id"],
      ["an empty release id", "req_d12_0002", ""],
    ];
    for (const [label, requestId, releaseId] of badRequests) {
      const res = await heartbeat(d12, { capable: true, request: { requestId, releaseId } });
      ok(res.response?.notice === "bad_request", `${label} is a bad request`, String(res.response?.notice));
      ok(res.response?.attempt === null, `and creates no attempt for ${label}`);
    }
    ok((await attemptCount(d12.id)) === before12, "hostile requests leave no rows behind");

    const missingRelease = await heartbeat(d12, {
      capable: true,
      request: { requestId: "req_d12_0003", releaseId: "A".repeat(24) },
    });
    ok(missingRelease.response?.notice === "release_unavailable", "a well-formed id for a release that never existed says so");
    ok((await attemptCount(d12.id)) === before12, "and still creates nothing");

    // The unique key is (device, request id), not the request id alone: two
    // screens racing with the same id must not collide.
    const d13 = await mkDevice();
    const [first, second] = await Promise.all([
      heartbeat(d12, { capable: true, request: { requestId: "req_shared_01", releaseId: rel1!.release.id } }),
      heartbeat(d13, { capable: true, request: { requestId: "req_shared_01", releaseId: rel1!.release.id } }),
    ]);
    ok(first.response?.attempt?.state === "accepted", "a shared request id is accepted on the first screen");
    ok(second.response?.attempt?.state === "accepted", "and accepted independently on a second screen");
    ok(first.response!.attempt!.id !== second.response!.attempt!.id, "with distinct attempt rows");

    // Nothing a screen receives may echo its bearer token or the stored hash.
    const token = tokens.get(d13.id)!;
    const hb = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ ota: { capable: true } }),
      }),
    );
    const hbText = await hb.text();
    ok(hb.status === 200 && !hbText.includes(token), "a heartbeat response never echoes the bearer token");
    ok(!hbText.includes("tokenHash") && !hbText.toLowerCase().includes("authorization"), "nor the stored hash or the header");

    const served = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", { headers: { authorization: `Bearer ${token}` } }),
    );
    const serveText = Buffer.from(await served.arrayBuffer()).toString("latin1");
    ok(!serveText.includes(token), "the artifact response never contains the token");
    const serveHeaders = Array.from(served.headers.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")
      .toLowerCase();
    ok(!serveHeaders.includes("token") && !serveHeaders.includes(token.toLowerCase()), "and no header leaks it either");

    // An unreadable body is still a heartbeat, and PATCH is the same endpoint.
    const d14 = await mkDevice();
    const malformed = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(d14.id)}` },
        body: "{this is not json",
      }),
    );
    ok(malformed.status === 200, "an unreadable heartbeat body is still a heartbeat");
    ok(
      (await prisma.device.findUniqueOrThrow({ where: { id: d14.id } })).lastSeenAt !== null,
      "and the liveness fact is still recorded",
    );

    const patched = await route.PATCH(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "PATCH",
        headers: { authorization: `Bearer ${tokens.get(d14.id)}` },
        body: JSON.stringify({ firmwareVer: "1.0.0", appliedRev: 2 }),
      }),
    );
    ok(patched.status === 200, "PATCH is the same heartbeat");
    ok((await prisma.device.findUniqueOrThrow({ where: { id: d14.id } })).firmwareVer === "1.0.0", "and writes the same facts");

    const noBody = await route.POST(
      new NextRequest("http://localhost/api/devices/heartbeat", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.get(d14.id)}` },
      }),
    );
    ok(noBody.status === 200, "a heartbeat with no body at all is accepted");

    // A release whose artifact vanishes after the tap is a 410 through the real
    // route, not a short 200 a bootloader would half-flash.
    const v3Image = buildImage({ version: "1.2.0", dataLen: 284 }).bytes;
    const rel3 = await ota.registerSharedRelease({ bytes: v3Image, version: "1.2.0", filename: "v3.bin", uploadedById: null });
    await ota.publishRelease(rel3.release.id);
    await ota.withdrawRelease(rel3.release.id);
    ok((await ota.getPublishedRelease()) === null, "withdrawing leaves nothing on offer");
    const republished = await ota.publishRelease(rel3.release.id);
    ok(republished.publishedAt !== null, "a withdrawn release can be published again deliberately");
    ok((await ota.getPublishedRelease())?.version === "1.2.0", "and is on offer again");

    const d15 = await mkDevice();
    const accepted15 = await heartbeat(d15, {
      capable: true,
      request: { requestId: "req_d15_0001", releaseId: rel3.release.id },
    });
    const a15 = accepted15.response!.attempt!.id;
    const served15 = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", { headers: { authorization: `Bearer ${tokens.get(d15.id)}` } }),
    );
    ok(served15.status === 200, "the newly pinned artifact serves before it is lost");

    fs.rmSync(path.join(tmp, "data", "firmware", "ota", "artifacts", `${rel3.release.sha256}.bin`));
    const gone = await stream.GET(
      new NextRequest("http://localhost/api/devices/ota", { headers: { authorization: `Bearer ${tokens.get(d15.id)}` } }),
    );
    ok(gone.status === 410, "a pinned artifact that vanished is 410, not a short 200");
    const goneBody = await gone.json();
    ok(typeof goneBody.error === "string" && goneBody.error.length > 0, "with a reason an operator can read");
    ok((await ota.getPublishedRelease()) === null, "and bytes that cannot be served are not offered to anyone");

    const stillPinned = await prisma.deviceOtaAttempt.findUniqueOrThrow({ where: { id: a15 } });
    ok(stillPinned.phase === "accepted", "the attempt is not silently rewritten by a failed read");
    ok((await ota.cancelAttempt(a15)).state === "failed", "and the operator can still end it");

    // The two silence windows have an inside and an outside, not just a middle.
    await ota.publishRelease(rel1!.release.id); // the offer the previous sections left behind
    const d16 = await mkDevice();
    const accepted16 = await heartbeat(d16, {
      capable: true,
      request: { requestId: "req_d16_0001", releaseId: rel1!.release.id },
    });
    const a16 = accepted16.response!.attempt!.id;
    await heartbeat(d16, { capable: true, report: { attemptId: a16, phase: "rebooting" } });

    ok(
      (await heartbeat(d16, { capable: true, report: { phase: "installing" } })).response?.notice === "bad_report",
      "a report with no attempt id is a bad report",
    );
    const rolledReport = await heartbeat(d16, {
      capable: true,
      report: { attemptId: a16, phase: "succeeded", bootResult: "rolled_back" },
    });
    ok(rolledReport.response?.notice === "bad_report", "a rolled-back boot cannot be claimed as success");

    await prisma.deviceOtaAttempt.update({
      where: { id: a16 },
      data: { updatedAt: new Date(Date.now() - ota.REBOOT_SILENCE_MS + 5000) },
    });
    ok((await ota.reconcileStaleAttempts(d16.id)) === 0, "five seconds inside the reboot window is still an install");

    await prisma.deviceOtaAttempt.update({
      where: { id: a16 },
      data: { updatedAt: new Date(Date.now() - ota.REBOOT_SILENCE_MS - 5000) },
    });
    ok((await ota.reconcileStaleAttempts(d16.id)) === 1, "five seconds past it is unknown");

    // The running-image block stays defensive even for shapes JSON can produce.
    ok(ota.parseInstalledInfo({ version: " 1.2.3 ", sha256: "A".repeat(64), slot: "app1" })?.version === "1.2.3",
      "a padded version is trimmed");
    ok(ota.parseInstalledInfo({ version: "1.2.3", sha256: `${"a".repeat(63)}\u0000` })?.sha256 === null,
      "a digest with a stripped control byte is discarded, not shortened into a match");
    ok(ota.parseInstalledInfo({ version: "1.2.3", sha256: "a".repeat(64), slot: ["app0"] })?.slot === null,
      "a slot that is not a string is discarded");
    ok(ota.parseInstalledInfo({ version: 123, sha256: 456 })?.version === null, "non-string fields are discarded");
    ok(ota.parseInstalledInfo([])?.version === null, "an array is an object with no usable fields, not a crash");

    ok(
      (await asyncCodeOf(() => ota.publishRelease(rel3.release.id))) === "artifact_missing",
      "publishing proves the bytes before moving the pointer",
    );
    ok((await ota.getPublishedRelease())?.version === "1.0.0", "and a failed publish leaves the current offer alone");
    ok(
      (await asyncCodeOf(() => ota.publishRelease("A".repeat(24)))) === "unknown_release",
      "publishing a release id that does not exist is a bounded 404",
    );
  }

} catch (e: any) {
  ok(false, "the OTA behaviour suite ran", String(e?.message || e).split("\n")[0]);
} finally {
  cleanup();
}

console.log(`  ${passed}/${passed + failed} shared-firmware OTA assertions passed`);
if (failed > 0) process.exit(1);
