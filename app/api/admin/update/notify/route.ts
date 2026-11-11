import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { updateNotifyKey, isUpdateNotifyOptedIn } from "@/lib/push";

/**
 * This admin's opt-in for update news. GET reads it, POST sets it — per
 * admin, not per device, so one choice covers their phone and their laptop.
 * Off unless explicitly on: update pushes are opt-IN.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!(session?.user as any)?.isAdmin || !userId) return new Response("Forbidden", { status: 403 });
  return NextResponse.json({ enabled: await isUpdateNotifyOptedIn(userId) });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!(session?.user as any)?.isAdmin || !userId) return new Response("Forbidden", { status: 403 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = body.enabled === true;
  const key = updateNotifyKey(userId);
  await prisma.setting.upsert({
    where: { key },
    update: { value: enabled ? "true" : "false" },
    create: { key, value: enabled ? "true" : "false" },
  });
  return NextResponse.json({ ok: true, enabled });
}
