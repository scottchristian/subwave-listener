import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { buildManifest, readFirmwareMeta, signFirmwarePart } from "@/lib/firmware-upload";

/**
 * The manifest the browser flasher reads, and the firmware it points at.
 *
 * Session-gated, because the binary it serves has the claim token compiled into
 * it: anyone holding factory.bin can claim that screen. The MANIFEST is fetched
 * by the operator's own page, so cookies are guaranteed here.
 *
 * The PART is a different story. esp-web-tools fetches the part itself, and
 * whether it sends cookies is not something we control or have verified — so the
 * part URL carries its own HMAC signature with a ten-minute expiry instead of
 * relying on that. The flash works either way, and a leaked URL stops working
 * almost immediately.
 *
 * One part, offset 0x0. A merged factory image including the bootloader; the
 * per-device credentials are compiled in, so there is no second part and no
 * partition table whose offset could be wrong.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Say which screen." }, { status: 400 });

  const row = await prisma.device.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "That screen is not registered." }, { status: 404 });
  if (!row.deviceId) {
    return NextResponse.json(
      { error: "This screen has not been built yet. Run the build command and upload the firmware first." },
      { status: 409 },
    );
  }

  const meta = await readFirmwareMeta(row.deviceId);
  if (!meta) {
    return NextResponse.json(
      { error: "No firmware has been uploaded for this screen." },
      { status: 409 },
    );
  }

  const { url } = signFirmwarePart(row.deviceId);
  return NextResponse.json(buildManifest(url), {
    headers: { "Cache-Control": "no-store", "x-firmware-sha256": meta.sha256 },
  });
}