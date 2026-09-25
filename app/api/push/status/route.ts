import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { vapidPublicKey } from "@/lib/push";

// Push readiness for the admin card: server key present + device count.
export async function GET() {
  const session = await getServerSession(authOptions);
  const dbId = (session?.user as any)?.id;
  if (!session?.user?.email || !dbId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dbUser = await prisma.user.findUnique({ where: { id: dbId } });
  if (!dbUser?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const devices = await prisma.pushSubscription.count({ where: { userId: dbId } });
  return NextResponse.json({ vapid: !!(await vapidPublicKey()), devices });
}
