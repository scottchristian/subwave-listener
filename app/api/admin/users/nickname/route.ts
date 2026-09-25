import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Set (or clear, with a blank value) a user's display nickname. Shown
// wherever the admin lists users instead of their sign-in name.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }
  let body: { userId?: unknown; nickname?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  const nickname =
    typeof body.nickname === "string" && body.nickname.trim()
      ? body.nickname.trim().slice(0, 100)
      : null;
  try {
    await prisma.user.update({ where: { id: body.userId }, data: { nickname } });
    return NextResponse.json({ success: true, nickname });
  } catch {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
}
