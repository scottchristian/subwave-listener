import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Revoke a grant: approved (and non-owner admin) accounts go back to pending.
// Cannot revoke yourself — that would lock the last admin out with no UI left.
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
    return NextResponse.json({ error: "You cannot revoke your own access" }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: body.userId },
    data: { isApproved: false, isAdmin: false },
  });
  return NextResponse.json({ success: true });
}
