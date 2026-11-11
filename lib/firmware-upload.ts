import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Receiving, validating and handing out compiled firmware.
 *
 * WHY THE SERVER NEVER COMPILES ANYTHING. Option B: the developer builds on their
 * own machine and uploads the result. Every candidate host was checked — the app
 * VPS has no Docker and 1.7GB of RAM, the station host is 99% full at 537MB
 * free, and an ESP-IDF build of a 1280x800 LVGL firmware wants 4-8GB. So there
 * is no build worker here, and deliberately so: the alternative is a queue, a
 * log streamer, a PlatformIO cache and a timeout for something a developer with
 * the toolchain already has.
 *
 * WHY AN UPLOAD IS TREATED AS HOSTILE INPUT. It is a 13MB file arriving from a
 * browser over the internet, and it is written to disk and later handed to a
 * flashing tool. Everything below is a boundary check rather than a formality.
 *
 * WHY THE STORED BINARY IS A SECRET. The claim token is compiled INTO the
 * firmware, so anyone holding factory.bin can claim that device. That is why the
 * download is a signed, expiring URL rather than a plain path — see
 * signFirmwarePart() — and why revoke deletes the file rather than just
 * refusing to serve it.
 */

/** Where uploads land. `data/` is already excluded from the deploy rsync. */
export const FIRMWARE_DIR = path.join(process.cwd(), "data", "firmware");

/**
 * Size ceiling.
 *
 * MUST MATCH the NGINX `client_max_body_size` on the app vhost exactly. That
 * vhost sets none of its own, so it inherits NGINX's default of 1MB and a 13MB
 * upload is rejected with a 413 before it ever reaches this code. The two numbers
 * are only as good as their agreement — change one and this must change with it.
 */
export const MIN_FIRMWARE_BYTES = 1_000_000;
export const MAX_FIRMWARE_BYTES = 20_000_000;

/** ESP32 image header. A merged factory image starts with this byte. */
const ESP_IMAGE_MAGIC = 0xe9;

/** Signed part URLs live this long. Long enough to flash, short enough to not be a shared secret. */
export const PART_URL_TTL_SECONDS = 600;

export class FirmwareValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}

export interface FirmwareMeta {
  sha256: string;
  sizeBytes: number;
  builtAt: string;
  uploadedById: string | null;
}

/** Per-device directory. Built from a cuid, never from anything a client sent. */
function deviceDir(deviceId: string): string {
  if (!/^[a-z0-9]{8,40}$/i.test(deviceId)) {
    throw new FirmwareValidationError("That is not a screen id.");
  }
  return path.join(FIRMWARE_DIR, deviceId);
}

export function firmwarePath(deviceId: string): string {
  return path.join(deviceDir(deviceId), "factory.bin");
}

/**
 * Reject anything that is not plausibly an ESP32 factory image.
 *
 * Size first because it is free and the caller is already holding the bytes;
 * magic second because a size check alone would happily store a text file named
 * factory.bin. Content type from the client is deliberately ignored — it is a
 * label the browser chooses, not evidence.
 */
export function validateFirmware(bytes: Uint8Array): { sha256: string; sizeBytes: number } {
  if (bytes.length < MIN_FIRMWARE_BYTES) {
    throw new FirmwareValidationError(
      `That file is ${(bytes.length / 1_000_000).toFixed(1)}MB. A compiled screen is at least ${(MIN_FIRMWARE_BYTES / 1_000_000).toFixed(0)}MB — this looks like the wrong file.`,
    );
  }
  if (bytes.length > MAX_FIRMWARE_BYTES) {
    throw new FirmwareValidationError(
      `That file is ${(bytes.length / 1_000_000).toFixed(1)}MB, over the ${(MAX_FIRMWARE_BYTES / 1_000_000).toFixed(0)}MB limit. Raise client_max_body_size on the app vhost if this is expected.`,
    );
  }
  if (bytes[0] !== ESP_IMAGE_MAGIC) {
    throw new FirmwareValidationError(
      "That is not a compiled screen. Upload the firmware.factory.bin from the build, not the project source.",
    );
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

/** Store a validated binary and its metadata. Overwrites any previous build. */
export async function saveFirmware(
  deviceId: string,
  bytes: Uint8Array,
  uploadedById: string | null,
): Promise<FirmwareMeta> {
  const dir = deviceDir(deviceId);
  await fs.mkdir(dir, { recursive: true });
  const { sha256, sizeBytes } = validateFirmware(bytes);

  // Write to a temp name and rename, so a crash mid-write cannot leave a
  // truncated image that passes the size check and bricks the next flash.
  const target = firmwarePath(deviceId);
  const tmp = path.join(dir, ".factory.bin.partial");
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, target);

  const meta: FirmwareMeta = { sha256, sizeBytes, builtAt: new Date().toISOString(), uploadedById };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export async function readFirmwareMeta(deviceId: string): Promise<FirmwareMeta | null> {
  try {
    const raw = await fs.readFile(path.join(deviceDir(deviceId), "meta.json"), "utf8");
    return JSON.parse(raw) as FirmwareMeta;
  } catch {
    return null;
  }
}

export async function readFirmware(deviceId: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(firmwarePath(deviceId));
  } catch {
    return null;
  }
}

/**
 * Delete a device's binary. Called on delete AND on revoke — a revoked device's
 * binary still carries a working claim token, so leaving it on disk leaves a
 * live credential behind for anyone who finds the file.
 */
export async function deleteFirmware(deviceId: string): Promise<void> {
  await fs.rm(deviceDir(deviceId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Signed part URLs
// ---------------------------------------------------------------------------

function firmwareSecret(): string {
  const secret = process.env.DEVICE_FIRMWARE_SECRET || process.env.NEXTAUTH_SECRET || "";
  if (!secret) {
    // Refusing is the safe answer: an unsigned URL would hand the claim token to
    // anyone who guessed a device id.
    throw new FirmwareValidationError("No firmware signing secret is configured, so a screen cannot be flashed.");
  }
  return secret;
}

function sign(deviceId: string, expires: number): string {
  return createHmac("sha256", firmwareSecret())
    .update(`${deviceId}.${expires}`)
    .digest("base64url")
    .slice(0, 43);
}

/**
 * A short-lived, unguessable URL for the binary.
 *
 * WHY NOT JUST GATE IT ON THE SESSION. The manifest itself is fetched by the page
 * with cookies, so that half is easy. Whether esp-web-tools sends cookies when
 * it fetches the manifest's PART is not something we control or have verified —
 * and if it does not, a cookie-gated binary either fails to flash or, worse,
 * gets served to a request with no session at all. So the part carries its own
 * proof and the tool's behaviour stops mattering.
 *
 * The URL is itself a bearer secret for ten minutes, which is the same trust
 * level as a password reset link. It must never be logged.
 */
export function signFirmwarePart(deviceId: string, now: number = Date.now()): { url: string; expiresAt: number } {
  const expires = Math.floor(now / 1000) + PART_URL_TTL_SECONDS;
  return { url: `/firmware/${deviceId}/${sign(deviceId, expires)}.bin?exp=${expires}`, expiresAt: expires * 1000 };
}

/**
 * Verify a signed part URL.
 *
 * Constant-time, and the expiry is checked here rather than trusted from the
 * query string — an attacker controls `exp`, so the signature has to be over the
 * value actually being claimed.
 */
export function verifyFirmwarePart(deviceId: string, signature: string, expires: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(expires) || expires * 1000 <= now) return false;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(signature)) return false;
  const expected = Buffer.from(sign(deviceId, expires));
  const given = Buffer.from(signature);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// esp-web-tools manifest
// ---------------------------------------------------------------------------

/**
 * The manifest the browser flasher reads.
 *
 * One part, offset 0x0 — a merged factory image including the bootloader. The
 * per-device credentials are compiled in, so there is no second part and no
 * partition table to get wrong.
 *
 * new_install_prompt_erase stays false: erasing a freshly soldered screen that
 * has nothing on it is a needless warning to talk someone past.
 */
export function buildManifest(partUrl: string) {
  return {
    name: "Subwave screen",
    version: "1.0.0",
    builds: [
      {
        chipFamily: "ESP32-P4",
        parts: [{ path: partUrl, offset: 0 }],
      },
    ],
    new_install_prompt_erase: false,
  };
}