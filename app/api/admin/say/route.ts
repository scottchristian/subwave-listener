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
  let lastErr = "Failed to reach station backend";
  // Styled mode burns an LLM call before speaking; the provider flakes
  // ("Invalid JSON response") and the backend has no retry. Our calls carry
  // no sfx, so a 500 means nothing aired yet — one retry is safe.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`${cfg.apiUrl}/dj/say`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode, kind }),
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return NextResponse.json(data, { status: res.status });
      lastErr = (data as any)?.error || `Backend answered ${res.status}`;
      // Only retry server-side flakes; client errors (400/401/403) never heal.
      if (res.status < 500) return NextResponse.json(data, { status: res.status });
    } catch (e) {
      console.error(`Admin say attempt ${attempt + 1} failed:`, e);
      lastErr = "Failed to reach station backend";
    }
  }
  return NextResponse.json({ error: lastErr }, { status: 502 });
}
