import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Remove an account outright. Donations keep their record (attribution
// nulled); sessions, likes, requests and push subscriptions cascade.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }
  let body: { userId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  if (body.userId === (session?.user as any)?.id) {
    return NextResponse.json({ error: "You cannot remove your own account" }, { status: 400 });
  }
  try {
    await prisma.donation.updateMany({
      where: { userId: body.userId },
      data: { userId: null },
    });
    await prisma.user.delete({ where: { id: body.userId } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
}
