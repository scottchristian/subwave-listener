import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getSubwaveConfig } from "@/lib/subwave";

// Prove the Spotify creds work end to end: client-credentials token plus one
// real search. Read-only, no state changed.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = await getSubwaveConfig();
  if (!cfg.spotifyClientId || !cfg.spotifyClientSecret) {
    return NextResponse.json({ error: "Spotify ID/secret not set" }, { status: 400 });
  }
  try {
    const basicAuth = Buffer.from(`${cfg.spotifyClientId}:${cfg.spotifyClientSecret}`).toString("base64");
    const tokRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15000),
    });
    if (!tokRes.ok) {
      return NextResponse.json({ error: `Spotify auth rejected (${tokRes.status}) — check ID/secret` }, { status: 502 });
    }
    const { access_token } = await tokRes.json();
    if (!access_token) {
      return NextResponse.json({ error: "Spotify gave no token" }, { status: 502 });
    }
    const q = encodeURIComponent(`track:"Get Lucky" artist:"Daft Punk"`);
    const sRes = await fetch(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!sRes.ok) {
      return NextResponse.json({ error: `Spotify search failed (${sRes.status})` }, { status: 502 });
    }
    const item = (await sRes.json()).tracks?.items?.[0];
    if (!item?.name) {
      return NextResponse.json({ error: "Spotify answered but found nothing" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      sample: `${item.name} — ${(item.artists || []).map((a: any) => a.name).join(", ")}`,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Spotify test failed" }, { status: 502 });
  }
}
