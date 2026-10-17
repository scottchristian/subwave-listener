import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";

/**
 * How a screen proves who it is.
 *
 * THE ONE RULE, and everything else here follows from it: this module reads ONE
 * input — the Authorization header. It does not read cookies, it does not resolve
 * a session, and it does not return or touch a User. A device is never a person.
 *
 * That is not a style preference. Sessions in this app are database-strategy
 * (prisma/schema.prisma), so the cookie value IS the session token: if firmware
 * ever stored or replayed one, anyone who could reach the screen over its
 * hotspot or the LAN would be that operator. Keeping the two credentials
 * structurally separate is what makes that impossible rather than merely
 * discouraged — see device/capabilities.md for the five ways a device drifts
 * into being a person, and which rule stops each.
 *
 * Admin permissions on PROVISIONING are separate from device permissions. An
 * operator can create a Device row, and that authorises the creation and nothing
 * after it. No screen is ever an admin, at any setting.
 */

/**
 * How long a rotated-out token keeps working, in minutes.
 *
 * THE PROBLEM THIS SOLVES. A device holds its token in flash. Rotate the stored
 * hash server-side and the device cannot learn the new one, because it
 * authenticates every request — including the one that would carry a
 * replacement — with the token being replaced. It is stranded: alive, polling,
 * and permanently 401. The fix is a grace window during which the old token is
 * still accepted and the heartbeat response carries the new one, which the
 * device writes over the top.
 *
 * The cost is real and bounded: a stolen old token stays usable for the window.
 * So keep it short. Fifteen minutes is generous for a device that heartbeats
 * every sixty seconds, and it means a lost token is dead in a quarter of an
 * hour rather than never.
 */
export const ROTATION_GRACE_MINUTES = 15;

/** Claim tokens outlive a server build by a wide margin, because option B. */
export const CLAIM_TOKEN_DAYS = 7;

/** sha256 hex. What is stored; the raw token is never retrievable again. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Compares without leaking length or content through timing. */
function secretEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, and the length of a hex digest
  // is not itself a disclosure worth protecting here.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 32 random bytes, base64url. A device credential, not a station secret. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface DeviceAuthed {
  /** The row's cuid. Stable, and never the secret. */
  id: string;
  deviceId: string;
  row: import("@prisma/client").Device;
  /** True when this request authenticated with a token inside a grace window. */
  viaRotation: boolean;
}

/** Pull the bearer token out of a request. Returns null rather than throwing. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}

/**
 * Authenticate a screen, or nothing.
 *
 * Checks the live token first, then the rotated-out one if it is still inside
 * its window. A revoked device is refused even with a valid token — revocation
 * is about the row, not the credential.
 */
export async function deviceAuth(req: Request): Promise<DeviceAuthed | null> {
  const raw = bearerToken(req);
  if (!raw) return null;

  const digest = hashToken(raw);

  // Two lookups rather than one OR-filter: tokenHash is indexed and is the hot
  // path, and prevTokenHash is only worth asking about if the first misses.
  const current = await prisma.device.findFirst({ where: { tokenHash: digest } });
  if (current && current.status !== "revoked") {
    return { id: current.id, deviceId: current.deviceId ?? "", row: current, viaRotation: false };
  }

  if (!current) {
    const rotated = await prisma.device.findFirst({
      where: { prevTokenHash: digest, prevTokenExpires: { gt: new Date() } },
    });
    if (rotated && rotated.status !== "revoked") {
      return { id: rotated.id, deviceId: rotated.deviceId ?? "", row: rotated, viaRotation: true };
    }
  }

  return null;
}

/** For routes that have nothing to do if the caller is not a screen. */
export async function requireDevice(req: Request): Promise<DeviceAuthed> {
  const authed = await deviceAuth(req);
  if (!authed) throw new DeviceAuthError();
  return authed;
}

export class DeviceAuthError extends Error {
  readonly status = 401;
  constructor() {
    super("Not a registered screen.");
  }
}

/**
 * START a rotation, from the admin panel.
 *
 * Note what this does NOT do: it does not mint a replacement. The admin cannot be
 * the one to receive the new token — they have no way to put it on the screen, so
 * handing it to them would mint a credential that exists nowhere useful. The
 * replacement is minted later, by the screen itself, in completeRotation().
 *
 * Instead the live hash is cleared and the current one becomes the grace token.
 * The screen is now mid-flight on the old credential, which keeps working for the
 * window; its next heartbeat mints the new one and receives it in the response.
 *
 * So exactly one rotation happens, the screen is the only party that ever sees
 * the replacement, and the window closes the moment the screen collects it. If the
 * screen never comes back inside the window the old token dies anyway and the
 * admin has to re-flash — the honest outcome for a device that cannot be reached,
 * and the admin panel says so rather than leaving it stranded.
 */
export async function beginRotation(row: import("@prisma/client").Device): Promise<{ expiresAt: Date }> {
  // Re-read rather than trusting the row passed in. Every caller gets that row
  // from a query and then immediately calls a minting function, which leaves them
  // holding an object whose tokenHash is still null — and promoting THAT to the
  // grace token silently produces a rotation that grants nothing while appearing
  // to work. Reading fresh removes the stale-object hazard instead of documenting
  // it and hoping.
  const current = await prisma.device.findUniqueOrThrow({ where: { id: row.id } });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ROTATION_GRACE_MINUTES * 60_000);
  await prisma.device.update({
    where: { id: row.id },
    data: { tokenHash: null, prevTokenHash: current.tokenHash, prevTokenExpires: expiresAt, rotatedAt: now },
  });
  return { expiresAt };
}

/**
 * FINISH a rotation, from the heartbeat that authenticated on the grace token.
 *
 * Mints the replacement and hands it to the screen in the same response. This is
 * the only place a long-lived device token is ever returned after its first
 * issue, and the raw value is returned exactly once — the screen writes it to
 * flash and the server keeps only the hash.
 *
 * Clears the grace hash in the same update, so the old token stops working the
 * instant the new one is delivered. No window is left dangling afterwards.
 */
export async function completeRotation(row: import("@prisma/client").Device): Promise<string> {
  const raw = newToken();
  await prisma.device.update({
    where: { id: row.id },
    data: { tokenHash: hashToken(raw), prevTokenHash: null, prevTokenExpires: null },
  });
  return raw;
}

/**
 * The FIRST token, at claim. No grace window: there is no device on the other
 * end yet, and the claim token it was built with is retired by this call.
 *
 * Retiring it HERE rather than leaving it to the caller is the point.
 * consumeClaimToken answers "used" when the stored hash is gone, and that answer
 * only means anything if something actually clears it — a claim token left in the
 * row would be replayable for its full seven days, which is long enough for a
 * firmware image to be copied off a build machine.
 */
export async function mintDeviceToken(row: import("@prisma/client").Device): Promise<string> {
  const raw = newToken();
  await prisma.device.update({
    where: { id: row.id },
    data: {
      tokenHash: hashToken(raw),
      prevTokenHash: null,
      prevTokenExpires: null,
      claimToken: null,
      claimExpires: null,
    },
  });
  return raw;
}

/**
 * A claim token, for compiling into firmware.
 *
 * Long-lived on purpose. Under a server-side build worker the gap between
 * creating a row and claiming was minutes; under option B the developer builds
 * locally and may not touch it for a day, so thirty minutes would expire the
 * token out from under a perfectly good binary.
 *
 * Regenerating one invalidates anything already built against the old value,
 * and the caller is expected to say so rather than let it fail at claim time.
 */
export async function mintClaimToken(
  row: import("@prisma/client").Device,
): Promise<{ raw: string; expires: Date }> {
  const raw = newToken();
  const expires = new Date(Date.now() + CLAIM_TOKEN_DAYS * 24 * 60 * 60_000);
  await prisma.device.update({
    where: { id: row.id },
    data: { claimToken: hashToken(raw), claimExpires: expires },
  });
  return { raw, expires };
}

/**
 * Consume a claim token, if it is a live one for this device.
 *
 * Single use: the row's stored hash is cleared in the same update that mints the
 * long-lived token, so a replay of the same pair finds nothing. Expired and
 * already-used are answered differently on purpose — "flash didn't complete" and
 * "someone removed this screen" are different problems for whoever is holding
 * the panel.
 */
export async function consumeClaimToken(
  deviceId: string,
  raw: string,
): Promise<{ ok: true; row: import("@prisma/client").Device } | { ok: false; reason: "unknown" | "used" | "expired" }> {
  const row = await prisma.device.findFirst({ where: { deviceId } });
  if (!row) return { ok: false, reason: "unknown" };
  // No stored hash means this token was already spent. Answering "used" rather
  // than "wrong" tells the operator the screen is fine and simply needs
  // re-registering, which is a different next step from a mistyped one.
  if (!row.claimToken) return { ok: false, reason: "used" };
  if (!secretEquals(row.claimToken, hashToken(raw))) return { ok: false, reason: "unknown" };
  if (!row.claimExpires || row.claimExpires.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, row };
}

/** Clear the grace window. Called once a device has acknowledged a rotation. */
export async function clearRotation(row: import("@prisma/client").Device): Promise<void> {
  await prisma.device.update({
    where: { id: row.id },
    data: { prevTokenHash: null, prevTokenExpires: null },
  });
}