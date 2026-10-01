import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { displayEmail, displayName } from "@/lib/pii";

// Presence: who actually has the app open right now. Auth session rows live
// for weeks after the tab closes, so they can't answer this — instead every
// poll writes a heartbeat and we count heartbeats fresher than 5 minutes
// (the player polls every 15s; closed tabs go quiet and age out).
const FRESH_MS = 5 * 60 * 1000;
// Streaming: an open StreamSession (no endTime) started recently. Restarts and
// dead sockets orphan rows, so only fresh opens count — a playing socket is
// always young. Dedupe by user (Safari opens ~2 rows per Play press).
const STREAMING_MS = 10 * 60 * 1000;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const me = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!me?.isApproved) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  await prisma.presenceHeartbeat.upsert({
    where: { userId: me.id },
    update: { lastSeen: now },
    create: { userId: me.id, lastSeen: now },
  });
  const fresh = await prisma.presenceHeartbeat.findMany({
    where: { lastSeen: { gte: new Date(now.getTime() - FRESH_MS) } },
    include: { user: { select: { id: true, name: true, nickname: true, email: true, emailEnc: true } } },
    orderBy: { lastSeen: "desc" },
  });
  const out: any = { signedIn: fresh.length };
  if ((session.user as any)?.isAdmin && me.isAdmin) {
    out.users = fresh.map((h) => ({
      userId: h.userId,
      name: displayName(h.user),
      email: displayEmail(h.user),
      lastSeen: h.lastSeen,
    }));
    const open = await prisma.streamSession.findMany({
      where: { endTime: null, startTime: { gte: new Date(now.getTime() - STREAMING_MS) } },
      include: { user: { select: { id: true, name: true, nickname: true, email: true, emailEnc: true } } },
      orderBy: { startTime: "asc" },
    });
    const seen = new Set<string>();
    out.streaming = [];
    for (const s of open) {
      if (seen.has(s.userId)) continue;
      seen.add(s.userId);
      out.streaming.push({
        userId: s.userId,
        name: displayName(s.user),
        email: displayEmail(s.user),
        since: s.startTime,
      });
    }
  }
  return NextResponse.json(out);
}
