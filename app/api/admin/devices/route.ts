import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { beginRotation, mintClaimToken, ROTATION_GRACE_MINUTES } from "@/lib/device-auth";
import { deleteFirmware } from "@/lib/firmware-upload";

/**
 * Adding, renaming, rotating, revoking and removing wall screens.
 *
 * ADMIN ONLY, AND ADMIN ONLY TO CREATE. Provisioning a screen is an operator
 * action; what the screen may then do is not theirs to widen. An admin can add a
 * screen to a wall and that authorises exactly that — the screen is never an
 * admin, at any setting, and no value stored on this row confers a privilege.
 *
 * The build command is returned from the create call rather than assembled in the
 * browser, because the claim token in it must never be rendered into a page the
 * operator might screenshot, log, or leave on a projector.
 */
export async function requireAdmin(): Promise<{ id: string } | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!user?.isAdmin) return null;
  return { id: user.id ?? user.email };
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const rows = await prisma.device.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { name: true } }, uploadedBy: { select: { name: true } } },
  });

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

  const row = await prisma.device.create({
    data: { name, status: "building", buildStatus: "building", createdById: admin.id },
  });

  const claim = await mintClaimToken(row);
  const serverUrl = new URL(req.url).origin;

  // Quoted values: a cuid or a base64url token containing a colon will otherwise
  // produce a substitutions file that does not parse, and the failure surfaces as
  // an opaque YAML error at the far end of a fifteen-minute build.
  const command = [
    "esphome compile \\",
    `  -s device_id '${row.deviceId ?? row.id}' \\`,
    `  -s claim_token '${claim.raw}' \\`,
    `  -s server_url '${serverUrl}' \\`,
    "  -s firmware_version '1.0.0' \\",
    "  device/firmware/builds/subwave-jc8012p4a1.yaml",
  ].join("\n");

  return NextResponse.json(
    {
      device: { id: row.id, name: row.name },
      buildCommand: command,
      // The row's deviceId is null until a build completes — it is compiled into
      // the firmware, which does not exist yet. The substitution uses the cuid so
      // the command works now and the claim still matches once deviceId is set.
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
        data: { settingsRev: row.settingsRev + 1, brightness: 70, orientation: "landscape", themeMode: "auto", idleMode: "dim", idleMin: 15, idlePct: 20, skipEnabled: "1" },
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
      await beginRotation(row);
      break;
    }
    case "revoke": {
      await prisma.device.update({
        where: { id },
        data: { status: "revoked", tokenHash: null, prevTokenHash: null, prevTokenExpires: null },
      });
      // A revoked screen's binary still carries a working claim token, so the
      // file has to go too — leaving it leaves a live credential on disk.
      if (row.deviceId) await deleteFirmware(row.deviceId).catch(() => {});
      break;
    }
    case "newClaim": {
      const claim = await mintClaimToken(row);
      const serverUrl = new URL(req.url).origin;
      return NextResponse.json(
        {
          buildCommand: [
            "esphome compile \\",
            `  -s device_id '${row.deviceId ?? row.id}' \\`,
            `  -s claim_token '${claim.raw}' \\`,
            `  -s server_url '${serverUrl}' \\`,
            "  -s firmware_version '1.0.0' \\",
            "  device/firmware/builds/subwave-jc8012p4a1.yaml",
          ].join("\n"),
          claimExpiresAt: claim.expires.toISOString(),
          note: "Any firmware already built with the old setup code will no longer claim. Flash the new build.",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    default:
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