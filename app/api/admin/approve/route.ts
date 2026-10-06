import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { dropSessionsForUser } from "@/lib/session-cache";



export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const me = session?.user as any;
  if (!me?.isAdmin && !me?.canApprove) {
    return new Response("Forbidden", { status: 403 });
  }

  const { userId } = await req.json();

  if (!userId) {
    return NextResponse.json({ error: "Missing userId" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { isApproved: true },
  });
  // A pending account has a cached "not approved" verdict. Drop it so the newly
  // approved listener is let in now, not when the interval happens to expire.
  dropSessionsForUser(userId);

  return NextResponse.json({ success: true });
}
