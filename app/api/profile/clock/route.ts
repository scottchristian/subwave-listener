import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// This user's clock face: 12-hour or 24-hour, everywhere in the app. Stored
// per user (clockHour12:<userId>) rather than per browser, so phone and
// laptop agree — a display preference, not a secret. Absent means "follow
// the device locale", decided client-side.
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!session?.user?.email || !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const row = await prisma.setting.findUnique({ where: { key: `clockHour12:${userId}` } });
    if (!row) return NextResponse.json({ hour12: null });
    return NextResponse.json({ hour12: row.value === "true" });
  } catch {
    return NextResponse.json({ error: "Could not read clock preference" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as any)?.id;
  if (!session?.user?.email || !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { hour12?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.hour12 !== "boolean") {
    return NextResponse.json({ error: "hour12 must be true or false" }, { status: 400 });
  }
  const key = `clockHour12:${userId}`;
  const value = body.hour12 ? "true" : "false";
  try {
    await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    return NextResponse.json({ hour12: body.hour12 });
  } catch {
    return NextResponse.json({ error: "Could not save clock preference" }, { status: 500 });
  }
}
