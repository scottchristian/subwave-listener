import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { displayEmail, displayName } from "@/lib/pii";
import { notePresence, freshPresence, liveStreams, toLivePerson, PRESENCE_WINDOW_MS } from "@/lib/presence-live";
import { noteActivity } from "@/lib/activity";

// Presence: who actually has the app open right now. Auth session rows live
// for weeks after the tab closes, so they can't answer this — instead every
// poll stamps process memory (lib/presence-live) and we count stamps fresher
// than 2 minutes (the player polls every 15s; closed tabs go quiet and age
// out). No database reads or writes on this path at all: a heartbeat every
// 15s per tab is exactly the idle traffic the free plan forbids.

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
  // Memory stamp for the background loops — they gate polling on this rather
  // than asking the database, because the question would keep it awake.
  noteActivity(now.getTime());
  // ...and the presence answer itself, same reason. The approval lookup above
  // is the only database touch on this path.
  notePresence(toLivePerson(me), now.getTime());
  const fresh = freshPresence(now.getTime());
  const out: any = { signedIn: fresh.length, windowMs: PRESENCE_WINDOW_MS };
  if ((session.user as any)?.isAdmin && me.isAdmin) {
    out.users = fresh.map((h) => ({
      userId: h.userId,
      name: displayName(h.person),
      email: displayEmail(h.person),
      lastSeen: h.lastSeen,
    }));
    out.streaming = liveStreams(now.getTime()).map((st) => ({
      userId: st.userId,
      name: displayName(st.person),
      email: displayEmail(st.person),
      since: st.since,
    }));
  }
  return NextResponse.json(out);
}
