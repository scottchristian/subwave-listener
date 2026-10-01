import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Mark the now-playing song to never air again. Mirrors Subwave admin
// `POST /library/blocklist {type, trackId}` (requireAdmin) — the backend
// resolves album/artist ids off the track and purges blocked items from the
// upcoming queue. Blocking does NOT stop the current play; pair with skip.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = await getSubwaveConfig();
  const auth = subwaveAdminAuth(cfg);
  if (!auth) {
    return NextResponse.json(
      { error: "Sub/Wave server username/password not set (Admin → Sub/Wave Server)" },
      { status: 500 }
    );
  }
  let body: { type?: unknown; trackId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!["track", "album", "artist"].includes(body.type as string)) {
    return NextResponse.json({ error: "type must be 'track', 'album' or 'artist'" }, { status: 400 });
  }
  if (!body.trackId || typeof body.trackId !== "string") {
    return NextResponse.json({ error: "trackId is required" }, { status: 400 });
  }
  try {
    const res = await fetch(`${cfg.apiUrl}/library/blocklist`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: body.type, trackId: body.trackId }),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    console.error("Admin block-track failed:", e);
    return NextResponse.json({ error: "Failed to reach station backend" }, { status: 502 });
  }
}
