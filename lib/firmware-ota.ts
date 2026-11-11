import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import prisma from "@/lib/prisma";
import { FIRMWARE_DIR } from "@/lib/firmware-upload";

/**
 * Shared (fleet) firmware OTA — the server half.
 *
 * THE PROBLEM THIS SOLVES. Per-device firmware exists so one screen can be set up
 * over USB with its own claim token compiled in. Updating forty screens that way
 * means forty people with a cable. This module adds a second, separate path: one
 * image, uploaded once, installed by every screen that asks for it.
 *
 * THREE RULES SHAPE EVERYTHING BELOW.
 *
 * 1. THE BYTES ARE THE IDENTITY. A release is addressed by its sha256. Re-uploading
 *    the same bytes is idempotent; uploading different bytes under a version that
 *    already exists is refused, because a fleet may be midway through installing
 *    the old ones. Artifacts are never deleted — a withdrawn release can still be
 *    pinned by an install in flight.
 *
 * 2. THE IMAGE MUST BE PROVABLY INSTALLABLE BEFORE IT IS OFFERED. A 2.7MB file
 *    arriving from a browser becomes a boot image on a wall. Size is checked
 *    against the actual A/B slot, the ESP app image structure is walked segment by
 *    segment, the checksum and appended SHA-256 are verified, the chip is checked,
 *    and the descriptor's own version must equal the release version. A merged
 *    factory image is refused: it starts with the bootloader and is meant for a
 *    USB cable, not for the OTA slot.
 *
 * 3. AN ATTEMPT IS A RESERVATION, NOT A HINT. "One active attempt per device" is a
 *    nullable unique column, so two heartbeats arriving together cannot both win.
 *    Transitions only move forward, a report for an ended attempt never rewrites a
 *    newer one, and silence after a reboot stays UNKNOWN rather than being guessed
 *    into success or failure.
 */

export const ESP_APP_MAGIC = 0xe9;
export const ESP_APP_DESC_MAGIC = 0xabcd5432;
export const ESP_IMAGE_HEADER_BYTES = 24;
export const ESP_APP_DESC_BYTES = 256;
export const ESP32P4_CHIP_ID = 18;

/** The app slot from partitions.csv: 0x7C0000, both app0 and app1. */
export const APP_SLOT_BYTES = 0x7c_0000;

/** Smallest plausible app image: header + first segment header + descriptor + checksum block. */
export const MIN_OTA_BYTES = 320;

/** Only the project names the Subwave screen firmware has ever used. */
export const OTA_PROJECTS = ["subwave-screen", "causewayfm.subwave-screen"] as const;

/** Where shared artifacts live. Private: no static route, only the device stream. */
export const OTA_ARTIFACT_DIR = path.join(FIRMWARE_DIR, "ota", "artifacts");

/** The single published-release pointer, in the existing key/value table. */
export const OTA_PUBLISHED_SETTING_KEY = "firmwareOtaPublishedReleaseId";

export class OtaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Same shape lib/version.ts compares, so ordering and storage agree. */
export function isValidReleaseVersion(value: string): boolean {
  return value.length > 0 && value.length <= 32 && VERSION_RE.test(value);
}

/**
 * Numeric ordering for dotted versions, mirroring lib/version.ts: "1.10.0" is
 * newer than "1.9.0", and a prerelease sorts below its own release. Leading
 * zeros do not make a different version — "1.02.0" and "1.2.0" are the same
 * number, which is what duplicate detection below uses to refuse a second
 * release under a version a fleet might already be installing.
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = VERSION_RE.exec(v.trim());
    if (!m) return null;
    return { parts: [Number(m[1]), Number(m[2]), Number(m[3])] as const, pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1; // a finished release is newer than its prerelease
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// ---------------------------------------------------------------------------
// ESP app image validation
// ---------------------------------------------------------------------------

export interface ParsedAppImage {
  sizeBytes: number;
  sha256: string;
  chipId: number;
  segmentCount: number;
  minChipRev: number;
  maxChipRev: number;
  hashAppended: boolean;
  descriptor: {
    magic: number;
    project: string;
    version: string;
    idfVersion: string;
  };
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const u16 = (b: Buffer, at: number) => b.readUInt16LE(at);
const u32 = (b: Buffer, at: number) => b.readUInt32LE(at);

/** A NUL-terminated, bounded, printable field from the app descriptor. */
function descriptorField(b: Buffer, at: number, len: number): string {
  const raw = b.subarray(at, at + len);
  const nul = raw.indexOf(0);
  const text = raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8");
  // Reject control characters rather than store them: this string ends up in the
  // release record and in operator-facing errors.
  return /^[ -~]*$/.test(text) ? text : "";
}

/**
 * Parse and verify one app-only ESP32 image.
 *
 * Mirrors the bootloader's own walk (esp_image_format.c in IDF 5.5): a 24-byte
 * packed header, `segment_count` × (8-byte segment header + word-aligned data),
 * then a 16-byte-aligned block whose LAST byte is the checksum, then an optional
 * 32-byte SHA-256 over everything through that block.
 *
 * The checksum is the esptool one — seed 0xEF, XOR every segment DATA byte — not a
 * sum and not a CRC. Getting this wrong would reject every real build, so it is
 * asserted against a real artifact in check-firmware-ota.mts.
 */
export function parseEspAppImage(input: Uint8Array): ParsedAppImage {
  const b = asBuffer(input);
  const size = b.length;

  if (size > APP_SLOT_BYTES) {
    throw new OtaError(
      "oversized",
      `That image is ${(size / 1_048_576).toFixed(2)}MB; the app slot is ${(APP_SLOT_BYTES / 1_048_576).toFixed(2)}MB. Build without debug symbols or trim the assets.`,
      413,
    );
  }
  if (size < MIN_OTA_BYTES) {
    throw new OtaError("truncated", `That file is ${size} bytes — too small to be a screen image.`, 400);
  }
  if (b[0] !== ESP_APP_MAGIC) {
    throw new OtaError(
      "not_app_image",
      b[0] === 0xff
        ? "That is a merged factory image (it starts with the bootloader). Upload firmware.ota.bin, which starts at the app."
        : "That is not a compiled screen image. Upload the OTA app image from the build.",
      400,
    );
  }

  const segmentCount = b[1];
  if (segmentCount < 1 || segmentCount > 16) {
    throw new OtaError("bad_header", `The image header claims ${segmentCount} segments; an app image has 1–16.`, 400);
  }

  const chipId = u16(b, 0x0c);
  if (chipId !== ESP32P4_CHIP_ID) {
    throw new OtaError(
      "wrong_chip",
      `That image targets chip id ${chipId}; this screen is an ESP32-P4 (${ESP32P4_CHIP_ID}).`,
      400,
    );
  }

  const minChipRev = u16(b, 0x0f);
  const maxChipRev = u16(b, 0x11);
  if (maxChipRev > 9999 || (maxChipRev !== 0 && maxChipRev < minChipRev)) {
    throw new OtaError("bad_header", "The chip revision range in the image header is not readable.", 400);
  }

  // Walk the segments. Every offset is bounded before use; a truncated file fails
  // here rather than in a bootloader 40 minutes later.
  const dataRanges: { start: number; end: number }[] = [];
  let offset = ESP_IMAGE_HEADER_BYTES;
  for (let i = 0; i < segmentCount; i++) {
    if (offset + 8 > size) {
      throw new OtaError("truncated", "The image ends inside a segment header.", 400);
    }
    const dataLen = u32(b, offset + 4);
    if (dataLen % 4 !== 0) {
      throw new OtaError("bad_header", "A segment length is not word-aligned, so the image is corrupt.", 400);
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + dataLen;
    if (dataEnd > size) {
      throw new OtaError("truncated", "The image ends inside a segment's data.", 400);
    }
    dataRanges.push({ start: dataStart, end: dataEnd });
    offset = dataEnd;
  }

  const segmentsEnd = offset;

  // The checksum lives in the LAST byte of the next 16-byte block; the bytes
  // before it are zero padding.
  const checksumBlock = ((segmentsEnd + 1 + 15) & ~15) - segmentsEnd;
  const checksumAt = segmentsEnd + checksumBlock - 1;
  if (checksumAt >= size) {
    throw new OtaError("truncated", "The image has no checksum block.", 400);
  }
  for (let i = segmentsEnd; i < checksumAt; i++) {
    if (b[i] !== 0) {
      throw new OtaError("bad_checksum", "The image's alignment padding is not zero.", 400);
    }
  }

  let checksum = 0xef;
  for (const range of dataRanges) {
    for (let i = range.start; i < range.end; i++) checksum ^= b[i];
  }
  if ((checksum & 0xff) !== b[checksumAt]) {
    throw new OtaError(
      "bad_checksum",
      `The image checksum does not match (calculated 0x${(checksum & 0xff).toString(16)}, found 0x${b[checksumAt].toString(16)}).`,
      400,
    );
  }

  const hashAppended = b[0x17] === 1;
  const imageEnd = checksumAt + 1;
  if (hashAppended) {
    if (size !== imageEnd + 32) {
      throw new OtaError(
        "truncated",
        size < imageEnd + 32
          ? "The image is missing its appended SHA-256."
          : "The image has unexpected bytes after its appended SHA-256.",
        400,
      );
    }
    const digest = createHash("sha256").update(b.subarray(0, imageEnd)).digest();
    if (!digest.equals(b.subarray(imageEnd, imageEnd + 32))) {
      throw new OtaError("bad_hash", "The image's appended SHA-256 does not match its bytes.", 400);
    }
  } else if (size !== imageEnd) {
    throw new OtaError("trailing_data", "The image has unexpected bytes after its checksum.", 400);
  }

  // The descriptor is at the start of segment 0's data: 24 + 8 = 32.
  if (dataRanges[0].end - dataRanges[0].start < ESP_APP_DESC_BYTES) {
    throw new OtaError("bad_descriptor", "The first segment is too small to contain an app descriptor.", 400);
  }
  const descAt = 0x20;
  const magic = u32(b, descAt);
  if (magic !== ESP_APP_DESC_MAGIC) {
    throw new OtaError("bad_descriptor", "The image has no app descriptor at offset 0x20.", 400);
  }
  const version = descriptorField(b, 0x30, 32);
  const project = descriptorField(b, 0x50, 32);
  const idfVersion = descriptorField(b, 0x90, 32);

  if (!project || !(OTA_PROJECTS as readonly string[]).includes(project)) {
    throw new OtaError(
      "wrong_project",
      `That image belongs to "${project || "an unnamed project"}", not a Subwave screen.`,
      400,
    );
  }
  if (!isValidReleaseVersion(version)) {
    throw new OtaError(
      "bad_descriptor",
      `The image descriptor carries version "${version}", which is not a dotted version this server can order.`,
      400,
    );
  }

  return {
    sizeBytes: size,
    sha256: createHash("sha256").update(b).digest("hex"),
    chipId,
    segmentCount,
    minChipRev,
    maxChipRev,
    hashAppended,
    descriptor: { magic, project, version, idfVersion },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function storageKeyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new OtaError("bad_hash", "That is not a sha256.", 400);
  return `ota/artifacts/${sha256}.bin`;
}

/** Resolve a stored key, refusing anything that is not one of our own keys. */
function artifactPathFor(storageKey: string): string {
  if (!/^ota\/artifacts\/[0-9a-f]{64}\.bin$/.test(storageKey)) {
    throw new OtaError("bad_storage_key", "The release's storage key is not valid.", 500);
  }
  return path.join(FIRMWARE_DIR, storageKey);
}

function safeFilename(name: unknown): string {
  if (typeof name !== "string") return "firmware.ota.bin";
  const base = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base ? base.slice(0, 120) : "firmware.ota.bin";
}

export interface ReleaseSummary {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  descriptorProject: string;
  descriptorVersion: string;
  chipId: number;
  createdAt: Date;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
}

function summarise(row: {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  descriptorProject: string;
  descriptorVersion: string;
  chipId: number;
  createdAt: Date;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
}): ReleaseSummary {
  return {
    id: row.id,
    version: row.version,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    filename: row.filename,
    descriptorProject: row.descriptorProject,
    descriptorVersion: row.descriptorVersion,
    chipId: row.chipId,
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    withdrawnAt: row.withdrawnAt,
  };
}

/**
 * Validate, store and register a shared release. Unpublished until publishRelease.
 *
 * The file is written under its sha256 and renamed into place, so a crash during
 * the write cannot leave a truncated artifact that a later boot trusts. Existing
 * identical bytes are reused rather than rewritten.
 */
export async function registerSharedRelease(input: {
  bytes: Uint8Array;
  version: string;
  filename: unknown;
  uploadedById: string | null;
}): Promise<{ release: ReleaseSummary; created: boolean }> {
  const version = (input.version ?? "").trim();
  if (!isValidReleaseVersion(version)) {
    throw new OtaError("bad_version", "Give the release a dotted version such as 1.15.0.", 400);
  }

  // Everything below runs on the bytes BEFORE anything touches the disk.
  const parsed = parseEspAppImage(input.bytes);
  if (parsed.descriptor.version !== version) {
    throw new OtaError(
      "descriptor_version_mismatch",
      `These bytes describe version ${parsed.descriptor.version}, not ${version}. Rebuild with ${version} in the app descriptor — a screen must be able to say which release it booted.`,
      400,
    );
  }

  const existingByVersion = await prisma.firmwareRelease.findUnique({ where: { version } });
  if (existingByVersion) {
    if (existingByVersion.sha256 === parsed.sha256) {
      return { release: summarise(existingByVersion), created: false };
    }
    throw new OtaError(
      "duplicate_version",
      `Version ${version} is already registered with different bytes. Publish a new version instead of replacing an image screens may already be installing.`,
      409,
    );
  }

  // The unique index compares strings; versions mean numbers. "01.2.0" is the
  // same release as "1.2.0" and must not become a second row that the fleet
  // treats as an alternative.
  const sameNumber = (await prisma.firmwareRelease.findMany({ select: { version: true } })).find(
    (r) => compareReleaseVersions(r.version, version) === 0,
  );
  if (sameNumber) {
    throw new OtaError(
      "duplicate_version",
      `Version ${version} is the same release as ${sameNumber.version}, which is already registered.`,
      409,
    );
  }
  const existingByHash = await prisma.firmwareRelease.findUnique({ where: { sha256: parsed.sha256 } });
  if (existingByHash) {
    throw new OtaError(
      "duplicate_artifact",
      `These bytes are already registered as version ${existingByHash.version}. Two versions cannot point at one image.`,
      409,
    );
  }

  const storageKey = storageKeyFor(parsed.sha256);
  const target = artifactPathFor(storageKey);
  await fs.mkdir(OTA_ARTIFACT_DIR, { recursive: true });

  const stat = await fs.stat(target).catch(() => null);
  if (stat) {
    // Hash-addressed, so the content is by definition the same; a size mismatch
    // means the file on disk was damaged and must not be silently reused.
    if (stat.size !== parsed.sizeBytes) {
      throw new OtaError("storage_corrupt", "The stored artifact does not match its hash. Remove it and upload again.", 500);
    }
  } else {
    const tmp = path.join(OTA_ARTIFACT_DIR, `.${parsed.sha256}.partial`);
    await fs.writeFile(tmp, input.bytes);
    await fs.rename(tmp, target);
  }

  try {
    const row = await prisma.firmwareRelease.create({
      data: {
        version,
        sha256: parsed.sha256,
        sizeBytes: parsed.sizeBytes,
        storageKey,
        filename: safeFilename(input.filename),
        descriptorProject: parsed.descriptor.project,
        descriptorVersion: parsed.descriptor.version,
        chipId: parsed.chipId,
        minChipRev: parsed.minChipRev,
        maxChipRev: parsed.maxChipRev,
        uploadedById: input.uploadedById,
      },
    });
    return { release: summarise(row), created: true };
  } catch (e) {
    // A concurrent upload of the same version/bytes is idempotent; anything else
    // is a real conflict. Never leave the promise as an unhandled unique error.
    if ((e as { code?: string }).code === "P2002") {
      const row = await prisma.firmwareRelease.findUnique({ where: { version } });
      if (row && row.sha256 === parsed.sha256) return { release: summarise(row), created: false };
      throw new OtaError("duplicate_version", `Version ${version} was registered concurrently with different bytes.`, 409);
    }
    throw e;
  }
}

/** Read a release's bytes and prove they are still what the record says. */
async function readReleaseBytes(row: { storageKey: string; sha256: string; sizeBytes: number }): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(artifactPathFor(row.storageKey));
  } catch {
    throw new OtaError("artifact_missing", "That release's artifact is not on disk.", 410);
  }
  if (bytes.length !== row.sizeBytes) {
    throw new OtaError("artifact_corrupt", "That release's artifact is the wrong length.", 410);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== row.sha256) {
    throw new OtaError("artifact_corrupt", "That release's artifact does not match its sha256.", 410);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/** The release screens may install right now, or null. Never writes. */
export async function getPublishedRelease(): Promise<ReleaseSummary | null> {
  try {
    const pointer = await prisma.setting.findUnique({ where: { key: OTA_PUBLISHED_SETTING_KEY } });
    if (!pointer?.value) return null;
    const row = await prisma.firmwareRelease.findUnique({ where: { id: pointer.value } });
    if (!row || row.withdrawnAt || !row.publishedAt) return null;
    // A pointer to bytes that cannot be served is not an offer. This is a stat,
    // not a read of the artifact.
    const stat = await fs.stat(artifactPathFor(row.storageKey)).catch(() => null);
    if (!stat || stat.size !== row.sizeBytes) return null;
    return summarise(row);
  } catch {
    // An unreadable pointer is "no offer", never a crash on a screen's heartbeat.
    return null;
  }
}

/**
 * Publish one release. The artifact is verified BEFORE the pointer moves, and the
 * pointer write is transactional with the release's own lifecycle fields, so a
 * heartbeat can never observe a published release whose bytes failed a check.
 */
export async function publishRelease(releaseId: string): Promise<ReleaseSummary> {
  const row = await prisma.firmwareRelease.findUnique({ where: { id: releaseId } });
  if (!row) throw new OtaError("unknown_release", "That release is not registered.", 404);
  await readReleaseBytes(row); // throws 410 if the bytes cannot be served

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const release = await tx.firmwareRelease.update({
      where: { id: releaseId },
      data: { publishedAt: row.publishedAt ?? now, withdrawnAt: null },
    });
    await tx.setting.upsert({
      where: { key: OTA_PUBLISHED_SETTING_KEY },
      update: { value: releaseId },
      create: { key: OTA_PUBLISHED_SETTING_KEY, value: releaseId },
    });
    return release;
  });
  return summarise(updated);
}

/**
 * Stop offering a release. The artifact and the row stay: an install already
 * pinned to this release is allowed to finish, and its download must still work.
 */
export async function withdrawRelease(releaseId: string): Promise<ReleaseSummary> {
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.firmwareRelease.findUnique({ where: { id: releaseId } });
    if (!row) throw new OtaError("unknown_release", "That release is not registered.", 404);
    const release = await tx.firmwareRelease.update({
      where: { id: releaseId },
      data: { withdrawnAt: row.withdrawnAt ?? now },
    });
    const pointer = await tx.setting.findUnique({ where: { key: OTA_PUBLISHED_SETTING_KEY } });
    if (pointer?.value === releaseId) {
      await tx.setting.delete({ where: { key: OTA_PUBLISHED_SETTING_KEY } });
    }
    return release;
  });
  return summarise(updated);
}

export async function listReleases(limit = 50): Promise<(ReleaseSummary & { attemptCount: number })[]> {
  const rows = await prisma.firmwareRelease.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
    include: { _count: { select: { attempts: true } } },
  });
  return rows.map((r) => ({ ...summarise(r), attemptCount: r._count.attempts }));
}

export async function listActiveAttempts(limit = 100) {
  const rows = await prisma.deviceOtaAttempt.findMany({
    where: { activeDeviceId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(500, limit)),
    include: { release: true, device: { select: { id: true, name: true } } },
  });
  return rows.map((a) => ({
    id: a.id,
    deviceId: a.deviceId,
    deviceName: a.device.name,
    releaseId: a.releaseId,
    version: a.release.version,
    phase: a.phase,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    errorCode: a.errorCode,
  }));
}

// ---------------------------------------------------------------------------
// Attempt lifecycle
// ---------------------------------------------------------------------------

export const OTA_PHASES = [
  "requested",
  "accepted",
  "downloading",
  "verifying",
  "installing",
  "rebooting",
  "succeeded",
  "failed",
  "rolled_back",
  "unknown",
  "rejected",
] as const;

export type OtaPhase = (typeof OTA_PHASES)[number];

/**
 * Forward-only. Higher wins; terminal phases end the attempt.
 *
 * `installing` stays between `verifying` and `rebooting` because an image can be
 * written to the inactive slot before the reboot, and the first firmware builds
 * used that word. New firmware may go straight from `verifying` to `rebooting`.
 */
const PHASE_RANK: Record<OtaPhase, number> = {
  requested: 0,
  accepted: 1,
  downloading: 2,
  verifying: 3,
  installing: 4,
  rebooting: 5,
  succeeded: 6,
  failed: 6,
  rolled_back: 6,
  unknown: 6,
  rejected: 6,
};

const TERMINAL_PHASES = new Set<OtaPhase>(["succeeded", "failed", "rolled_back", "unknown", "rejected"]);

/**
 * Phases a device may report. `requested`/`rejected` are server decisions, and
 * `unknown` is what the server derives from silence — a device cannot assert it.
 */
const REPORTABLE_PHASES = new Set<OtaPhase>([
  "accepted",
  "downloading",
  "verifying",
  "installing",
  "rebooting",
  "succeeded",
  "failed",
  "rolled_back",
]);

/** Before the reboot there is still an image to serve; after it, there is not. */
const DOWNLOADABLE_PHASES = new Set<OtaPhase>(["accepted", "downloading", "verifying", "installing"]);

export const isTerminalPhase = (phase: string): boolean => TERMINAL_PHASES.has(phase as OtaPhase);
export const isDownloadablePhase = (phase: string): boolean => DOWNLOADABLE_PHASES.has(phase as OtaPhase);

export function isForwardPhase(from: string, to: OtaPhase): boolean {
  const a = PHASE_RANK[from as OtaPhase];
  const b = PHASE_RANK[to];
  return a !== undefined && b !== undefined && b > a;
}

export interface AttemptView {
  id: string;
  state: string;
  releaseId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  downloadUrl: string | null;
}

type AttemptRow = {
  id: string;
  phase: string;
  releaseId: string;
  release: { version: string; sha256: string; sizeBytes: number };
};

/** Only a live install may be downloaded; an ended one has nothing to fetch. */
export function attemptView(a: AttemptRow): AttemptView {
  return {
    id: a.id,
    state: a.phase,
    releaseId: a.releaseId,
    version: a.release.version,
    sha256: a.release.sha256,
    sizeBytes: a.release.sizeBytes,
    downloadUrl: isDownloadablePhase(a.phase) ? "/api/devices/ota" : null,
  };
}

type DeviceRow = {
  id: string;
  status: string;
  deviceId: string | null;
  tokenHash: string | null;
  prevTokenExpires: Date | null;
};

/** A rotation is pending: the live token is clearing or already cleared. */
export function rotationPending(row: Pick<DeviceRow, "tokenHash" | "prevTokenExpires">, now = new Date()): boolean {
  return row.tokenHash === null || Boolean(row.prevTokenExpires && row.prevTokenExpires > now);
}

export interface OtaRequestInput {
  requestId: string;
  releaseId: string;
}

export interface OtaRequestResult {
  attempt: AttemptView | null;
  notice: string | null;
}

const NOTICE = {
  publicationChanged: "publication_changed",
  alreadyInProgress: "already_in_progress",
  rotationInProgress: "rotation_in_progress",
  releaseUnavailable: "release_unavailable",
  requestRejected: "request_rejected",
  badRequest: "bad_request",
  deviceRevoked: "device_revoked",
} as const;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9]{8,40}$/;

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";
const isWriteConflict = (e: unknown) => (e as { code?: string })?.code === "P2034";

/**
 * How long silence is allowed before an attempt becomes `unknown`.
 *
 * A screen heartbeats every sixty seconds, so these are generous rather than
 * tight: a slow download is still an install, but a screen that stopped talking
 * after a reboot is not evidence of success OR failure. The two bounds differ
 * because a 2.7MB download on a poor signal can legitimately take many minutes,
 * while a rebooted screen either comes back within a few minutes or it does not.
 *
 * The outcome is `unknown`, the reservation is released, and the operator can
 * retry. Leaving it live forever is the one choice that turns a lost report into
 * a permanently wedged screen.
 */
export const INSTALL_SILENCE_MS = 30 * 60_000;
export const REBOOT_SILENCE_MS = 15 * 60_000;

/**
 * Reap attempts whose screen stopped reporting. Idempotent and safe to call from
 * a heartbeat as well as from the admin list.
 *
 * This is deliberately a time check on `updatedAt`, not on a separate deadline
 * column: every transition already touches that column, so there is one fact to
 * keep correct instead of two.
 */
export async function reconcileStaleAttempts(deviceId?: string): Promise<number> {
  const now = new Date();
  const scope = deviceId ? { deviceId } : {};
  const [silentReboot, silentInstall] = await Promise.all([
    prisma.deviceOtaAttempt.updateMany({
      where: {
        ...scope,
        activeDeviceId: { not: null },
        phase: "rebooting",
        updatedAt: { lt: new Date(now.getTime() - REBOOT_SILENCE_MS) },
      },
      data: {
        phase: "unknown",
        activeDeviceId: null,
        finishedAt: now,
        errorCode: "silence_after_reboot",
        errorMessage: "The screen did not report after its reboot; the outcome is unknown.",
      },
    }),
    prisma.deviceOtaAttempt.updateMany({
      where: {
        ...scope,
        activeDeviceId: { not: null },
        phase: { in: ["accepted", "downloading", "verifying", "installing"] },
        updatedAt: { lt: new Date(now.getTime() - INSTALL_SILENCE_MS) },
      },
      data: {
        phase: "unknown",
        activeDeviceId: null,
        finishedAt: now,
        errorCode: "silence_during_install",
        errorMessage: "The screen stopped reporting during the install; the outcome is unknown.",
      },
    }),
  ]);
  return silentReboot.count + silentInstall.count;
}

/**
 * An explicit install tap. Creates at most one live attempt, idempotently.
 *
 * This is the only place an attempt starts, and it is only reached from a
 * heartbeat that carried the device's own request. Availability checks elsewhere
 * in the heartbeat create nothing.
 */
export async function requestOtaInstall(device: DeviceRow, input: OtaRequestInput): Promise<OtaRequestResult> {
  if (!REQUEST_ID_RE.test(input.requestId) || !ID_RE.test(input.releaseId)) {
    return { attempt: null, notice: NOTICE.badRequest };
  }

  // Revocation is the outermost refusal: a revoked row (whose token is already
  // cleared, so the rotation check below would answer first) must never be
  // advised to retry, and must never be handed an existing attempt as if it
  // could still be used.
  if (device.status === "revoked") return { attempt: null, notice: NOTICE.deviceRevoked };

  // Lost response / reboot: the same request id returns the same row, whatever
  // state it has reached.
  const replay = await prisma.deviceOtaAttempt.findUnique({
    where: { deviceId_requestId: { deviceId: device.id, requestId: input.requestId } },
    include: { release: true },
  });
  if (replay) {
    return {
      attempt: attemptView(replay),
      notice: replay.phase === "rejected" ? rejectionNotice(replay.errorCode) : null,
    };
  }

  // One live attempt per device. A second tap while one is running does NOT
  // consume its request id: the operator's next tap must still be usable.
  const live = await prisma.deviceOtaAttempt.findFirst({
    where: { activeDeviceId: device.id },
    include: { release: true },
  });
  if (live) {
    return { attempt: attemptView(live), notice: NOTICE.alreadyInProgress };
  }

  if (rotationPending(device)) {
    // No row: the same request id can be retried after the grace window closes.
    return { attempt: null, notice: NOTICE.rotationInProgress };
  }

  const requestedRelease = await prisma.firmwareRelease.findUnique({ where: { id: input.releaseId } });
  if (!requestedRelease) return { attempt: null, notice: NOTICE.releaseUnavailable };

  const now = new Date();
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Lock the Device row FIRST. beginRotation and recordOtaReport write the
      // same row, so this serializes the three of them: whichever transaction
      // gets the row first commits its decision, and the others re-read the
      // committed state instead of acting on a stale snapshot. Without this,
      // two heartbeats could pass their checks on Postgres READ COMMITTED and
      // both commit a rotation and an install. SQLite masks that; this does not.
      const locked = await tx.device.updateMany({
        where: { id: device.id },
        data: { updatedAt: now },
      });
      if (locked.count === 0) return { notice: "device_revoked" as const };

      // Re-read inside the transaction, after the lock: revocation and rotation
      // are boundaries, and a check that ran before the await is not a boundary.
      const current = await tx.device.findUnique({
        where: { id: device.id },
        select: { status: true, tokenHash: true, prevTokenExpires: true },
      });
      if (!current || current.status === "revoked") return { notice: "device_revoked" as const };
      if (rotationPending(current, now)) return { notice: NOTICE.rotationInProgress };

      const alreadyLive = await tx.deviceOtaAttempt.findFirst({
        where: { activeDeviceId: device.id },
        include: { release: true },
      });
      if (alreadyLive) return { attempt: alreadyLive, notice: NOTICE.alreadyInProgress };

      const pointer = await tx.setting.findUnique({ where: { key: OTA_PUBLISHED_SETTING_KEY } });
      const release = await tx.firmwareRelease.findUnique({ where: { id: input.releaseId } });
      if (!release) return { notice: NOTICE.releaseUnavailable };

      if (pointer?.value !== input.releaseId || release.withdrawnAt || !release.publishedAt) {
        // The operator tapped for an image that is no longer the offer. Record
        // the refusal so a retry of this request id is idempotent, then require a
        // NEW tap: a publication change is exactly the case where continuing
        // silently would install something the operator did not choose.
        const rejected = await tx.deviceOtaAttempt.create({
          data: {
            requestId: input.requestId,
            deviceId: device.id,
            releaseId: release.id,
            phase: "rejected",
            errorCode: NOTICE.publicationChanged,
            errorMessage: `Requested release ${release.version} is not the published release.`,
            finishedAt: now,
          },
          include: { release: true },
        });
        return { attempt: rejected, notice: NOTICE.publicationChanged };
      }

      const attempt = await tx.deviceOtaAttempt.create({
        data: {
          requestId: input.requestId,
          deviceId: device.id,
          releaseId: release.id,
          phase: "accepted",
          activeDeviceId: device.id,
          acceptedAt: now,
        },
        include: { release: true },
      });
      return { attempt, notice: null };
    });

    if ("notice" in outcome && !outcome.attempt) {
      return {
        attempt: null,
        notice: outcome.notice === "device_revoked" ? "device_revoked" : outcome.notice,
      };
    }
    return { attempt: outcome.attempt ? attemptView(outcome.attempt) : null, notice: outcome.notice ?? null };
  } catch (e) {
    if (isUnique(e) || isWriteConflict(e)) {
      // Two heartbeats raced. The database picked one; answer with it.
      const won = await prisma.deviceOtaAttempt.findFirst({
        where: { activeDeviceId: device.id },
        include: { release: true },
      });
      if (won) return { attempt: attemptView(won), notice: NOTICE.alreadyInProgress };
      const sameRequest = await prisma.deviceOtaAttempt.findUnique({
        where: { deviceId_requestId: { deviceId: device.id, requestId: input.requestId } },
        include: { release: true },
      });
      if (sameRequest) return { attempt: attemptView(sameRequest), notice: rejectionNotice(sameRequest.errorCode) };
    }
    throw e;
  }
}

function rejectionNotice(errorCode: string | null): string | null {
  if (errorCode === NOTICE.publicationChanged) return NOTICE.publicationChanged;
  return NOTICE.requestRejected;
}

/**
 * End one live attempt on an operator's say-so. Used when a screen is gone, stuck
 * on a cable, or the operator is about to do something that cannot wait for the
 * silence window. Only a live attempt can be cancelled; an ended one is history
 * and is never rewritten.
 */
export async function cancelAttempt(attemptId: string): Promise<AttemptView> {
  if (!ID_RE.test(attemptId)) throw new OtaError("bad_request", "That is not an attempt id.", 400);
  const now = new Date();
  const moved = await prisma.deviceOtaAttempt.updateMany({
    where: { id: attemptId, activeDeviceId: { not: null } },
    data: {
      phase: "failed",
      activeDeviceId: null,
      finishedAt: now,
      errorCode: "cancelled_by_operator",
      errorMessage: "An operator cancelled this install.",
    },
  });
  if (moved.count === 0) throw new OtaError("no_active_attempt", "That install is not active.", 409);
  const row = await prisma.deviceOtaAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { release: true },
  });
  return attemptView(row);
}

export interface OtaInstalledInfo {
  version: string | null;
  sha256: string | null;
  slot: "app0" | "app1" | null;
}

/** Normalize the running-image block a heartbeat reports. Never throws. */
export function parseInstalledInfo(raw: unknown): OtaInstalledInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const version = bounded(r.version, 32);
  const sha = bounded(r.sha256, 64);
  return {
    version: version && isValidReleaseVersion(version) ? version : null,
    sha256: sha && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null,
    slot: r.slot === "app0" || r.slot === "app1" ? r.slot : null,
  };
}

export interface OtaReportInput {
  attemptId: string;
  phase: string;
  bootResult?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** What the screen says it is running right now. Required to prove success. */
  installed?: OtaInstalledInfo | null;
}

export interface OtaReportResult {
  applied: boolean;
  attempt: AttemptView | null;
  notice: string | null;
}

const bounded = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  // Strip control characters before they reach a column or an operator's screen.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean ? clean.slice(0, max) : null;
};

/**
 * A device's progress or boot result.
 *
 * Only the live attempt may move, only forwards. A report for an attempt that has
 * already ended — because a newer one started, because it was reaped as unknown,
 * or because the response was lost and replayed — is acknowledged as stale and
 * changes nothing.
 *
 * SUCCESS IS NOT A DEVICE ASSERTION. `succeeded` requires the heartbeat's own
 * running-image block to name the pinned release's version and sha256. If it
 * names anything else the attempt ends `failed`, because a screen that says it
 * booted a different image has not proved the install the server recorded.
 */
export async function recordOtaReport(device: DeviceRow, report: OtaReportInput): Promise<OtaReportResult> {
  if (!ID_RE.test(report.attemptId) || !REPORTABLE_PHASES.has(report.phase as OtaPhase)) {
    return { applied: false, attempt: null, notice: "bad_report" };
  }
  const target = report.phase as OtaPhase;
  const bootResult = report.bootResult === "ok" || report.bootResult === "rolled_back" ? report.bootResult : null;
  const errorCode = bounded(report.errorCode, 64);
  const errorMessage = bounded(report.errorMessage, 500);
  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize against revocation and rotation on the Device row, as the
      // request path does. A revoked row stays revoked even if this report was
      // already in flight when the operator clicked.
      const locked = await tx.device.updateMany({ where: { id: device.id }, data: { updatedAt: now } });
      if (locked.count === 0) return { applied: false, attempt: null, notice: "device_revoked" };

      const deviceRow = await tx.device.findUnique({ where: { id: device.id }, select: { status: true } });
      if (!deviceRow || deviceRow.status === "revoked") {
        // Revocation ends the device's ability to move an attempt, and never
        // reactivates it.
        return { applied: false, attempt: null, notice: "device_revoked" };
      }

      const attempt = await tx.deviceOtaAttempt.findUnique({
        where: { id: report.attemptId },
        include: { release: true },
      });
      if (!attempt || attempt.deviceId !== device.id) {
        return { applied: false, attempt: null, notice: "stale_report" };
      }
      if (attempt.activeDeviceId !== device.id) {
        // Ended, reaped, or superseded by a newer attempt. Never overwrite it.
        return { applied: false, attempt: attemptView(attempt), notice: "stale_report" };
      }
      if (isTerminalPhase(attempt.phase)) {
        return { applied: false, attempt: attemptView(attempt), notice: "stale_report" };
      }
      if (target === (attempt.phase as OtaPhase)) {
        // Replay of an acknowledged state: idempotent, no write.
        return { applied: true, attempt: attemptView(attempt), notice: null };
      }

      // A success claim becomes a failure when the running image disagrees.
      let effective: OtaPhase = target;
      let provedInstalled: OtaInstalledInfo | null = null;
      let mismatchMessage: string | null = null;
      if (target === "succeeded") {
        if (bootResult !== "ok") {
          return { applied: false, attempt: attemptView(attempt), notice: "bad_report" };
        }
        const reported = report.installed;
        if (!reported?.version || !reported.sha256) {
          // Not a failure yet: the next heartbeat may carry the installed block.
          // If it never does, the silence window turns this into `unknown`.
          return { applied: false, attempt: attemptView(attempt), notice: "installed_not_reported" };
        }
        const sameVersion = compareReleaseVersions(reported.version, attempt.release.version) === 0;
        const sameSha = reported.sha256.toLowerCase() === attempt.release.sha256.toLowerCase();
        if (!sameVersion || !sameSha) {
          effective = "failed";
          mismatchMessage =
            `Reported running ${reported.version} (${reported.sha256.slice(0, 12)}…), ` +
            `expected ${attempt.release.version} (${attempt.release.sha256.slice(0, 12)}…).`;
        } else {
          provedInstalled = reported;
        }
      }

      if (!isForwardPhase(attempt.phase, effective)) {
        return { applied: false, attempt: attemptView(attempt), notice: "stale_report" };
      }

      const terminal = isTerminalPhase(effective);
      const data: Record<string, unknown> = {
        phase: effective,
        bootResult: effective === "rolled_back" ? "rolled_back" : bootResult,
        ...(effective === "installing" ? { installingAt: now } : {}),
        ...(effective === "rebooting" ? { rebootingAt: now } : {}),
        ...(terminal ? { finishedAt: now, activeDeviceId: null } : {}),
      };
      if (effective === "failed" && mismatchMessage) {
        data.errorCode = "success_mismatch";
        data.errorMessage = mismatchMessage;
      } else {
        if (errorCode) data.errorCode = errorCode;
        if (errorMessage) data.errorMessage = errorMessage;
      }

      // Optimistic: the phase we read must still be the phase on disk. A second
      // heartbeat that raced us loses here instead of writing over our result.
      const moved = await tx.deviceOtaAttempt.updateMany({
        where: { id: attempt.id, phase: attempt.phase, activeDeviceId: device.id },
        data,
      });
      if (moved.count === 0) {
        return { applied: false, attempt: attemptView(attempt), notice: "stale_report" };
      }

      const updated = await tx.deviceOtaAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        include: { release: true },
      });

      if (effective === "succeeded" && provedInstalled) {
        // The confirmed boot is the only evidence that becomes the running-image
        // fact. The canonical release values are stored, not the device's
        // spelling of them. A concurrent revocation still wins.
        await tx.device.updateMany({
          where: { id: device.id, status: { not: "revoked" } },
          data: {
            otaCapable: true,
            otaInstalledVersion: updated.release.version,
            otaInstalledSha: updated.release.sha256,
            otaInstalledAt: now,
            ...(provedInstalled.slot ? { otaInstalledSlot: provedInstalled.slot } : {}),
          },
        });
      }

      return {
        applied: true,
        attempt: attemptView(updated),
        notice: effective === "failed" && mismatchMessage ? "success_mismatch" : null,
      };
    });
  } catch (e) {
    if (isWriteConflict(e)) {
      // Another report won the race. Its result is the truth; ours is stale.
      const current = await prisma.deviceOtaAttempt.findUnique({
        where: { id: report.attemptId },
        include: { release: true },
      });
      return {
        applied: false,
        attempt: current ? attemptView(current) : null,
        notice: "stale_report",
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Artifact stream
// ---------------------------------------------------------------------------

export type ArtifactResult =
  | { ok: true; bytes: Buffer; release: ReleaseSummary; attemptId: string }
  | { ok: false; status: 401 | 409 | 410; error: string };

/**
 * The bytes for a screen's live accepted attempt — and only that.
 *
 * There is no URL parameter and no path to choose: the server resolves the
 * attempt from the authenticated device. A screen cannot ask for another device's
 * image, another release, or arbitrary bytes.
 */
export async function readActiveArtifact(device: DeviceRow): Promise<ArtifactResult> {
  const deviceRow = await prisma.device.findUnique({ where: { id: device.id }, select: { status: true } });
  if (!deviceRow || deviceRow.status === "revoked") {
    return { ok: false, status: 401, error: "This screen is not set up." };
  }

  const attempt = await prisma.deviceOtaAttempt.findFirst({
    where: {
      activeDeviceId: device.id,
      phase: { in: ["accepted", "downloading", "verifying", "installing"] },
    },
    include: { release: true },
  });
  if (!attempt) {
    return { ok: false, status: 409, error: "No update is being installed on this screen." };
  }

  try {
    const bytes = await readReleaseBytes(attempt.release);
    return { ok: true, bytes, release: summarise(attempt.release), attemptId: attempt.id };
  } catch (e) {
    return {
      ok: false,
      status: 410,
      error: e instanceof OtaError ? e.message : "That release's artifact cannot be served.",
    };
  }
}

// ---------------------------------------------------------------------------
// Heartbeat orchestration
// ---------------------------------------------------------------------------

export interface OtaHeartbeatResponse {
  capable: true;
  published: { releaseId: string; version: string; sha256: string; sizeBytes: number } | null;
  attempt: AttemptView | null;
  notice: string | null;
}

export interface OtaHeartbeatResult {
  /** Device columns the heartbeat's single row update should include. */
  patch: Record<string, unknown>;
  /** Null for firmware that has never advertised OTA support. */
  response: OtaHeartbeatResponse | null;
}

/**
 * Everything OTA-related in one heartbeat, in one place.
 *
 * The route keeps its single Device write: this returns a patch rather than
 * updating the row itself. The only writes here are an explicit request or a
 * report — a heartbeat that merely asks "is there anything?" writes no attempt.
 */
export async function handleOtaHeartbeat(input: {
  row: DeviceRow & { otaCapable?: boolean };
  ota: unknown;
  viaRotation: boolean;
}): Promise<OtaHeartbeatResult> {
  const raw = input.ota && typeof input.ota === "object" ? (input.ota as Record<string, unknown>) : null;
  const capable = raw?.capable === true;

  if (!capable && !input.row.otaCapable) {
    // Old firmware: one property read, no queries, no response key. It keeps
    // working exactly as before.
    return { patch: {}, response: null };
  }

  // A screen that has gone quiet must not leave a live attempt reserved forever.
  // Availability checks run this too: opening Settings is exactly when the
  // operator should learn that the previous attempt is unknown and retryable.
  await reconcileStaleAttempts(input.row.id).catch(() => 0);

  const patch: Record<string, unknown> = {};
  if (capable && !input.row.otaCapable) patch.otaCapable = true;

  const installed = parseInstalledInfo(raw?.installed);

  let attempt: AttemptView | null = null;
  let notice: string | null = null;
  let reportSucceeded = false;

  const report = raw?.report;
  if (report && typeof report === "object") {
    const r = report as Record<string, unknown>;
    const result = await recordOtaReport(input.row, {
      attemptId: typeof r.attemptId === "string" ? r.attemptId : "",
      phase: typeof r.phase === "string" ? r.phase : "",
      bootResult: typeof r.bootResult === "string" ? r.bootResult : null,
      errorCode: typeof r.errorCode === "string" ? r.errorCode : null,
      errorMessage: typeof r.errorMessage === "string" ? r.errorMessage : null,
      installed,
    }).catch(() => ({ applied: false, attempt: null, notice: "bad_report" }) as OtaReportResult);
    attempt = result.attempt;
    notice = result.notice;
    reportSucceeded = result.applied && result.attempt?.state === "succeeded";
  }

  const request = raw?.request;
  if (request && typeof request === "object") {
    const r = request as Record<string, unknown>;
    if (input.viaRotation) {
      // Rotation and an install are mutually exclusive. The rotation completes in
      // this same response; the operator's next tap is the explicit retry.
      notice = NOTICE.rotationInProgress;
    } else {
      const result = await requestOtaInstall(input.row, {
        requestId: typeof r.requestId === "string" ? r.requestId : "",
        releaseId: typeof r.releaseId === "string" ? r.releaseId : "",
      }).catch(() => ({ attempt: null, notice: NOTICE.badRequest }) as OtaRequestResult);
      attempt = result.attempt;
      notice = result.notice;
    }
  }

  const live = await prisma.deviceOtaAttempt.findFirst({
    where: { activeDeviceId: input.row.id },
    include: { release: true },
  });
  if (!attempt) attempt = live ? attemptView(live) : null;

  // The running-image block is a fact about the screen, not about the install.
  // While an attempt is live it must not be written over the target's record;
  // a verified success has already stored the canonical release values above.
  // With no live attempt this is the best evidence the panel has of what runs.
  if (!live && installed && !reportSucceeded) {
    if (installed.version) patch.otaInstalledVersion = installed.version;
    if (installed.sha256) patch.otaInstalledSha = installed.sha256;
    if (installed.slot) patch.otaInstalledSlot = installed.slot;
  }

  // Availability. Read-only: no attempt is created by looking.
  const published = await getPublishedRelease();

  return {
    patch,
    response: {
      capable: true,
      published: published
        ? { releaseId: published.id, version: published.version, sha256: published.sha256, sizeBytes: published.sizeBytes }
        : null,
      attempt,
      notice,
    },
  };
}
