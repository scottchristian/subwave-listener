import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Presence: how many distinct users hold a live session. Anyone approved
// sees the count; admins also see who.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const me = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!me?.isApproved) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const live = await prisma.session.findMany({
    where: { expires: { gt: new Date() } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { expires: "desc" },
  });
  const seen = new Map<string, { name: string | null; email: string | null }>();
  for (const s of live) {
    if (!seen.has(s.userId)) seen.set(s.userId, { name: s.user?.name ?? null, email: s.user?.email ?? null });
  }
  const out: any = { signedIn: seen.size };
  if ((session.user as any)?.isAdmin && me.isAdmin) {
    out.users = [...seen.entries()].map(([userId, u]) => ({ userId, ...u }));
  }
  return NextResponse.json(out);
}
