import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { mintClaimToken } from "@/lib/device-auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const bindCode = typeof body?.bindCode === "string" ? body.bindCode.trim().toUpperCase() : "";

  if (!bindCode) {
    return NextResponse.json({ error: "Enter the bind code shown on the admin panel." }, { status: 400 });
  }

  const row = await prisma.device.findUnique({ where: { bindCode } });
  if (!row) {
    return NextResponse.json({ error: "That bind code is not recognised." }, { status: 404 });
  }
  if (row.bindCodeExpires && row.bindCodeExpires < new Date()) {
    return NextResponse.json({ error: "That bind code has expired. Generate a new one." }, { status: 410 });
  }

  const deviceId = row.deviceId ?? row.id;
  const claim = await mintClaimToken(row);

  await prisma.device.update({
    where: { id: row.id },
    data: {
      deviceId,
      claimToken: claim.raw,
      claimExpires: claim.expires,
      bindCode: null,
      bindCodeExpires: null,
      status: "building",
    },
  });

  return NextResponse.json(
    {
      deviceId,
      claimToken: claim.raw,
      claimExpiresAt: claim.expires.toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
