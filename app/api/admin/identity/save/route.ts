import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { applyIdentity } from "@/lib/applyidentity";
import { getHostIdentity, resetHostIdentityCache } from "@/lib/hostidentity";

// Current public identity values (all public info — safe to serve to admin).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Name and description are the host's. Report what it says now, falling back to
  // the baked copy only when it cannot be reached — the panel shows these read-only.
  const host = await getHostIdentity();
  return NextResponse.json({
    name: host.name || process.env.NEXT_PUBLIC_STATION_NAME || "",
    tagline: process.env.NEXT_PUBLIC_STATION_TAGLINE || "",
    description: host.description || process.env.NEXT_PUBLIC_STATION_DESCRIPTION || "",
    about: process.env.NEXT_PUBLIC_STATION_ABOUT || "",
    logo: process.env.NEXT_PUBLIC_STATION_LOGO || "",
    backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || "",
    donateUrl: process.env.NEXT_PUBLIC_DONATE_URL || "",
    nextauthUrl: process.env.NEXTAUTH_URL || "",
  });
}

// Save station identity (NEXT_PUBLIC_* — baked at build time), then rebuild and
// restart so the new branding goes live. The work itself lives in
// lib/applyidentity, because the first-run wizard does exactly the same sequence
// and two copies of a build-and-verify routine drift.
//
// NEXTAUTH_SECRET, DATABASE_URL and PM2_APP_NAME stay env-only on purpose.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const str = (k: string) => String(body[k] ?? "").trim();
  const backendUrl = str("backendUrl");
  const nextauthUrl = str("nextauthUrl");
  if (!backendUrl || !nextauthUrl) {
    return NextResponse.json(
      { error: "Backend URL and app URL are required" },
      { status: 400 }
    );
  }

  // Deliberately NOT taken from the request body. The name and the description are
  // the SUB/WAVE host's, so a POST that carries them is ignored for those two keys
  // and they are read from the host instead — that is what stops this panel from
  // being a second way to set them.
  const host = await getHostIdentity({ fresh: true });
  if (!host.name) {
    return NextResponse.json(
      {
        error:
          "Could not read your station's name from the SUB/WAVE host, so there is nothing to bake in. Check Admin → Sub/WAVE Server.",
      },
      { status: 502 }
    );
  }
  const name = host.name;
  for (const [label, v] of [["backend URL", backendUrl], ["app URL", nextauthUrl]] as const) {
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return NextResponse.json({ error: `${label} must be an http(s) URL` }, { status: 400 });
    }
  }

  const result = await applyIdentity({
    name,
    tagline: str("tagline"),
    description: host.description || "",
    about: str("about"),
    logo: str("logo"),
    backendUrl,
    donateUrl: str("donateUrl"),
    nextauthUrl,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  resetHostIdentityCache();
  return NextResponse.json({ ok: true, restarting: result.restarting, reason: result.reason });
}
