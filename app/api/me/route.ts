import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Fresh access state for the pending screen's approval poll. 404 means the
// account is gone (revoked-and-removed) — show "access denied", not "pending".
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  return NextResponse.json({
    email: user.email,
    isApproved: user.isApproved,
    isAdmin: user.isAdmin,
    nickname: user.nickname,
  });
}
