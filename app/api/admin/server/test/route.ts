import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Prove the Sub/Wave Server card values work: backend reachable (public
// now-playing) + admin credentials accepted (admin settings read).
// Read-only — changes nothing on either side.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) {
    return NextResponse.json({ error: "Server address not set" }, { status: 400 });
  }
  try {
    const np = await fetch(`${cfg.apiUrl}/now-playing`, { signal: AbortSignal.timeout(15000) });
    if (!np.ok) {
      return NextResponse.json(
        { error: `Backend answered ${np.status} — check server address` },
        { status: 502 }
      );
    }
    const data = await np.json().catch(() => ({}));
    const track = data?.nowPlaying?.title
      ? `${data.nowPlaying.title} — ${data.nowPlaying.artist || "unknown"}`
      : "nothing reported";
    const listeners = data?.listeners?.current;
    const auth = subwaveAdminAuth(cfg);
    if (!auth) {
      return NextResponse.json({
        ok: true,
        warning: "Reachable, but username/password not set — skip and never-play will fail",
        track,
        listeners: typeof listeners === "number" ? listeners : null,
      });
    }
    const st = await fetch(`${cfg.apiUrl}/settings`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    });
    if (st.status === 401 || st.status === 403) {
      return NextResponse.json(
        { error: "Backend reachable, but username/password rejected", track, listeners: typeof listeners === "number" ? listeners : null },
        { status: 502 }
      );
    }
    if (!st.ok) {
      return NextResponse.json(
        { error: `Backend reachable, admin check answered ${st.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      track,
      listeners: typeof listeners === "number" ? listeners : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Cannot reach backend (${(e as Error).message || "network error"}) — check server address` },
      { status: 502 }
    );
  }
}
