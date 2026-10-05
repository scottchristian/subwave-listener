import { NextRequest, NextResponse } from "next/server";
import { displayEmail, displayName } from "@/lib/pii";
import { notePresence, freshPresence, liveStreams, toLivePerson, PRESENCE_WINDOW_MS } from "@/lib/presence-live";
import { noteActivity } from "@/lib/activity";
import { cachedSession, sessionTokenFromCookies } from "@/lib/session-cache";

// Presence: who actually has the app open right now. Auth session rows live
// for weeks after the tab closes, so they can't answer this — instead every
// poll stamps process memory (lib/presence-live) and we count stamps fresher
// than 2 minutes (the player polls every 15s; closed tabs go quiet and age
// out). No database reads or writes on this path at all: a heartbeat every
// 15s per tab is exactly the idle traffic the free plan forbids.

export async function GET(req: NextRequest) {
  // Session + approval from the memory cache — this route fires every 15s
  // per open tab, and getServerSession plus an approval lookup per poll is
  // exactly the recurring database cost the free plan forbids. Revocation
  // lands within a minute, approval changes within five; admin routes keep
  // verifying directly.
  const me = await cachedSession(sessionTokenFromCookies(req));
  if (!me || !me.isApproved) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const now = new Date();
  // Memory stamp for the background loops — they gate polling on this rather
  // than asking the database, because the question would keep it awake.
  noteActivity(now.getTime());
  // ...and the presence answer itself, same reason. The approval lookup above
  // is the only database touch on this path.
  notePresence(toLivePerson({ ...me, id: me.userId }), now.getTime());
  const fresh = freshPresence(now.getTime());
  const out: any = { signedIn: fresh.length, windowMs: PRESENCE_WINDOW_MS };
  if (me.isAdmin) {
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
