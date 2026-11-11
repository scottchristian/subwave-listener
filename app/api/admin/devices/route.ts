import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { beginRotation, mintClaimToken, RotationBlockedError, ROTATION_GRACE_MINUTES } from "@/lib/device-auth";
import { requireAdmin } from "@/lib/admin-auth";
import { reconcileStaleAttempts } from "@/lib/firmware-ota";
import { deleteFirmware } from "@/lib/firmware-upload";

/**
 * Adding, renaming, rotating, revoking and removing wall screens.
 *
 * ADMIN ONLY, AND ADMIN ONLY TO CREATE. Provisioning a screen is an operator
 * action; what the screen may then do is not theirs to widen. An admin can add a
 * screen to a wall and that authorises exactly that — the screen is never an
 * admin, at any setting, and no value stored on this row confers a privilege.
 *
 * The create call returns a short bind code, not a compiled-in credential. The
 * screen claims its own token after the operator enters the code, so no secret
 * is rendered into a page the operator might screenshot, log, or leave on a
 * projector — and the build command no longer embeds a version the server has
 * no business guessing. The release version comes from the firmware build.
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  // The panel is how an operator learns that a screen went quiet, so reap stale
  // reservations here as well as on the heartbeat. Without this, a screen that
  // never comes back leaves the panel saying "installing" for ever.
  await reconcileStaleAttempts().catch(() => 0);

  const rows = await prisma.device.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { name: true } }, uploadedBy: { select: { name: true } } },
  });

  // Exactly one row per device, in two bounded queries. A plain findMany of all
  // attempts grows without limit as history accumulates; a findFirst per device
  // is a query per row. groupBy gives the newest createdAt, and the second query
  // fetches those rows, so the cost is proportional to the fleet size.
  const latestTimes = rows.length
    ? await prisma.deviceOtaAttempt.groupBy({
        by: ["deviceId"],
        where: { deviceId: { in: rows.map((d) => d.id) } },
        _max: { createdAt: true },
      })
    : [];
  const attemptPins = latestTimes
    .filter((g) => g._max.createdAt)
    .map((g) => ({ deviceId: g.deviceId, createdAt: g._max.createdAt! }));
  const attemptRows = attemptPins.length
    ? await prisma.deviceOtaAttempt.findMany({
        where: { OR: attemptPins },
        select: {
          id: true,
          deviceId: true,
          phase: true,
          errorCode: true,
          errorMessage: true,
          bootResult: true,
          requestedAt: true,
          finishedAt: true,
          updatedAt: true,
          release: { select: { version: true } },
        },
      })
    : [];
  const latestAttempt = new Map<string, (typeof attemptRows)[number]>();
  for (const a of attemptRows) latestAttempt.set(a.deviceId, a);

  return NextResponse.json(
    {
      devices: rows.map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        status: d.status,
        // A row can exist before its binary does, which is what makes "flash
        // didn't complete" a visible state rather than a ghost that reports in.
        hasFirmware: Boolean(d.firmwareSha),
        bindCode: d.bindCode,
        firmwareVer: d.firmwareVer,
        lastSeenAt: d.lastSeenAt,
        settingsRev: d.settingsRev,
        appliedRev: d.appliedRev,
        orientation: d.orientation,
        themeMode: d.themeMode,
        idleMode: d.idleMode,
        skipEnabled: d.skipEnabled !== "0",
        timezone: d.timezone,
        createdBy: d.createdBy?.name ?? null,
        uploadedBy: d.uploadedBy?.name ?? null,
        // Shared-firmware state. `otaCapable` is reported by firmware that
        // understands the shared-release protocol; every image built before it
        // leaves this false, so false means "not reported", not "cannot".
        otaCapable: d.otaCapable,
        otaInstalledVersion: d.otaInstalledVersion,
        otaInstalledSha: d.otaInstalledSha,
        otaInstalledSlot: d.otaInstalledSlot,
        otaInstalledAt: d.otaInstalledAt,
        otaAttempt: (() => {
          const a = latestAttempt.get(d.id);
          if (!a) return null;
          return {
            id: a.id,
            phase: a.phase,
            version: a.release.version,
            errorCode: a.errorCode,
            errorMessage: a.errorMessage,
            bootResult: a.bootResult,
            requestedAt: a.requestedAt,
            finishedAt: a.finishedAt,
            updatedAt: a.updatedAt,
          };
        })(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "Screen";

  // A short human-readable code the device operator types in during setup.
  // Single-use: consumed on first bind. Format: "AB1-C23" (3 chars, dash, 3 chars).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to avoid confusion
  let bindCode = "";
  for (let i = 0; i < 6; i++) {
    if (i === 3) bindCode += "-";
    bindCode += chars[Math.floor(Math.random() * chars.length)];
  }
  const bindCodeExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const row = await prisma.device.create({
    data: { name, status: "building", buildStatus: "building", createdById: admin.id, bindCode, bindCodeExpires },
  });

  const claim = await mintClaimToken(row);
  // The device connects to THIS host from out in the world, so the URL has to
  // be the public one, not the loopback address the Next.js server hears on
  // internally (which is what `new URL(req.url).origin` gave: localhost:3000,
  // and a firmware built with that URL could never reach the station). The
  // public origin is rebuilt from the forwarded headers, the same way the
  // Sub/Wave controller does it for its own tune-in URLs.
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.headers.get("host") || "localhost:3000";
  const proto = forwardedProto || (req.url.startsWith("https") ? "https" : "http");
  const serverUrl = `${proto}://${host}`;

  // The version is deliberately absent. It belongs to the firmware build, where
  // the descriptor, ESPHome project version and runtime banner can be made to
  // agree; a hardcoded literal here was a second, silently wrong source.
  void serverUrl;

  return NextResponse.json(
    {
      device: { id: row.id, name: row.name },
      bindCode,
      bindCodeExpires: bindCodeExpires.toISOString(),
      claimExpiresAt: claim.expires.toISOString(),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === "string" ? body.id : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!id || !action) return NextResponse.json({ error: "Say which screen and what to do." }, { status: 400 });

  const row = await prisma.device.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "That screen is not registered." }, { status: 404 });

  switch (action) {
    case "rename": {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return NextResponse.json({ error: "Give it a name." }, { status: 400 });
      await prisma.device.update({ where: { id }, data: { name } });
      break;
    }
    case "resetSettings": {
      await prisma.device.update({
        where: { id },
        data: { settingsRev: row.settingsRev + 1, brightness: 70, orientation: "landscape", themeMode: "auto", idleMode: "dim", idleMin: 15, idlePct: 20, idleOffMin: 0, skipEnabled: "1" },
      });
      break;
    }
    case "rotateCredentials": {
      // A screen that has not been seen for longer than the grace window cannot
      // be reached by the handoff, and rotating anyway would strand it: alive,
      // polling, and permanently refused. Say so instead of doing it quietly.
      const window = ROTATION_GRACE_MINUTES * 60_000;
      if (row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() > window) {
        return NextResponse.json(
          { error: "This screen has not checked in recently, so it cannot pick up a new credential. Flash it again instead." },
          { status: 409 },
        );
      }
      try {
        await beginRotation(row);
      } catch (e) {
        if (e instanceof RotationBlockedError) {
          return NextResponse.json({ error: e.message }, { status: e.status });
        }
        throw e;
      }
      break;
    }
    case "revoke": {
      // The live attempt is ended in the same transaction as the revocation, not
      // left to age out. Its token stops authenticating the moment this commits,
      // so the screen can never report on it again: "failed" is the honest end
      // state, and the reservation must be released or a later attempt would be
      // refused as already-in-progress by a device nobody can talk to.
      await prisma.$transaction(async (tx) => {
        await tx.device.update({
          where: { id },
          data: { status: "revoked", tokenHash: null, prevTokenHash: null, prevTokenExpires: null },
        });
        await tx.deviceOtaAttempt.updateMany({
          where: { deviceId: id, activeDeviceId: { not: null } },
          data: {
            phase: "failed",
            activeDeviceId: null,
            finishedAt: new Date(),
            errorCode: "device_revoked",
            errorMessage: "The screen was revoked while an install was in flight.",
          },
        });
      });
      // A revoked screen's binary still carries a working claim token, so the
      // file has to go too — leaving it leaves a live credential on disk.
      if (row.deviceId) await deleteFirmware(row.deviceId).catch(() => {});
      break;
    }
    case "newClaim": {
      // Re-provisioning replaces the identity the screen presents. An attempt
      // pinned to the old identity can never be reported on, so end it for the
      // same reason as revocation.
      await prisma.deviceOtaAttempt.updateMany({
        where: { deviceId: id, activeDeviceId: { not: null } },
        data: {
          phase: "failed",
          activeDeviceId: null,
          finishedAt: new Date(),
          errorCode: "reprovisioned",
          errorMessage: "The screen was re-provisioned while an install was in flight.",
        },
      });
      // Generate a fresh bind code for re-provisioning
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let bindCode = "";
      for (let i = 0; i < 6; i++) {
        if (i === 3) bindCode += "-";
        bindCode += chars[Math.floor(Math.random() * chars.length)];
      }
      const bindCodeExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const claim = await mintClaimToken(row);
      await prisma.device.update({
        where: { id },
        data: { bindCode, bindCodeExpires },
      });
      return NextResponse.json(
        {
          bindCode,
          bindCodeExpires: bindCodeExpires.toISOString(),
          claimExpiresAt: claim.expires.toISOString(),
          note: "New bind code generated. Enter this code on the device along with the server address.",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }    default:
      return NextResponse.json({ error: "That is not something a screen can do." }, { status: 400 });
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Say which screen." }, { status: 400 });

  const row = await prisma.device.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "That screen is not registered." }, { status: 404 });
  if (row.deviceId) await deleteFirmware(row.deviceId).catch(() => {});
  await prisma.device.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}