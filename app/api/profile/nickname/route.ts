import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Let a user set their own display nickname (blank clears back to sign-in name).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { nickname?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const nickname =
    typeof body.nickname === "string" && body.nickname.trim()
      ? body.nickname.trim().slice(0, 100)
      : null;
  try {
    await prisma.user.update({ where: { email: session.user.email }, data: { nickname } });
    return NextResponse.json({ success: true, nickname });
  } catch {
    return NextResponse.json({ error: "Failed to save nickname" }, { status: 500 });
  }
}
