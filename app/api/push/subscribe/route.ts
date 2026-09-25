import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Register this device for admin push alerts (new access requests).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const dbId = (session?.user as any)?.id;
  if (!session?.user?.email || !dbId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dbUser = await prisma.user.findUnique({ where: { id: dbId } });
  if (!dbUser?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  }
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { p256dh, auth, userId: dbId },
    create: { userId: dbId, endpoint, p256dh, auth },
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const dbId = (session?.user as any)?.id;
  if (!session?.user?.email || !dbId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { endpoint?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.endpoint === "string" && body.endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: dbId } });
  }
  return NextResponse.json({ success: true });
}
