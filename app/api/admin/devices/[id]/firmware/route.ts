import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { readFirmware, saveFirmware } from "@/lib/firmware-upload";

/**
 * Receive compiled firmware. Option B: the developer builds on their own machine
 * and hands the result over here, because no server that runs this app has a
 * container runtime or the four to eight gigabytes an ESP-IDF build wants.
 *
 * Uploads are capped at MAX_FIRMWARE_BYTES, which is deliberately the same number
 * as the NGINX client_max_body_size on the app vhost. They have to agree: that
 * vhost sets none of its own, so it inherits NGINX's default of 1MB and anything
 * larger is refused with a 413 before this code ever runs.
 *
 * ADMIN ONLY. Whoever can upload firmware can flash a screen, which is how that
 * screen joins the station — so it is not a lesser permission than provisioning,
 * and it is not available to anyone who merely runs skills.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { getServerSession } = await import("next-auth/next");
  const { authOptions } = await import("@/app/api/auth/[...nextauth]/route");
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  const { id } = await ctx.params;
  const row = await prisma.device.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "That screen is not registered." }, { status: 404 });

  let bytes: Buffer;
  try {
    const form = await req.formData();
    const file = form.get("firmware");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach the compiled firmware." }, { status: 400 });
    }
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "The upload could not be read." }, { status: 400 });
  }

  try {
    const meta = await saveFirmware(row.deviceId ?? row.id, bytes, (session?.user as any)?.id ?? null);
    // The deviceId in the firmware must match the row, or the screen will never
    // be able to claim. Nothing can verify that without booting it, so the row is
    // stamped here and the claim is where a mismatch would surface.
    await prisma.device.update({
      where: { id },
      data: {
        buildStatus: "built",
        firmwareSha: meta.sha256,
        builtAt: new Date(meta.builtAt),
        deviceId: row.deviceId ?? row.id,
        uploadedById: (session?.user as any)?.id ?? null,
      },
    });
    return NextResponse.json(meta, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "That file cannot be used." }, { status: err?.status ?? 400 });
  }
}

/** The same bytes, for anyone debugging a bad flash without a second upload. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { getServerSession } = await import("next-auth/next");
  const { authOptions } = await import("@/app/api/auth/[...nextauth]/route");
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  const { id } = await ctx.params;
  const row = await prisma.device.findUnique({ where: { id } });
  if (!row?.deviceId) return NextResponse.json({ error: "No firmware for that screen." }, { status: 404 });

  const bytes = await readFirmware(row.deviceId);
  if (!bytes) return NextResponse.json({ error: "No firmware for that screen." }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
    },
  });
}