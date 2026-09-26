import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Admin-only manual voice DJ. Mirrors Subwave `POST /dj/say` (requireAdmin):
// mode raw speaks verbatim, styled rewrites in persona; kind dj-speak = solo
// heavy duck (say.txt), link = over-track light duck (intro.txt).
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
  let body: { text?: unknown; mode?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  const mode = body.mode === "styled" ? "styled" : "raw";
  const kind = body.kind === "link" ? "link" : "dj-speak";
  try {
    const res = await fetch(`${cfg.apiUrl}/dj/say`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode, kind }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    console.error("Admin say failed:", e);
    return NextResponse.json({ error: "Failed to reach station backend" }, { status: 502 });
  }
}
