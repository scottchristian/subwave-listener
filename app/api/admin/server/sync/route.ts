import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { getSubwaveConfig } from "@/lib/subwave";
import { syncRelay } from "@/lib/relay";

// Repoint the local 1-to-many Icecast relay at the saved Sub/Wave Server
// settings (backend host/port + master password) and reload Icecast.
// The relay is what every listener actually plays — without this, changing
// the server card would strand it on the old master and kill the stream.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const cfg = await getSubwaveConfig();
  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, apiUrl: cfg.apiUrl });
  }
  try {
    const result = await syncRelay({ apiUrl: cfg.apiUrl, stationPassword: cfg.stationPassword });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("Relay sync failed:", e);
    return NextResponse.json({ error: (e as Error).message || "Relay sync failed" }, { status: 500 });
  }
}
