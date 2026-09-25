import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Listener-facing skip. Allowed when the skipper is the only listener
// (admins bypass the headcount). The backend has no listener skip — this
// route checks solo status then forwards with station admin credentials.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isAdmin = !!(session?.user as any)?.isAdmin;
  try {
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user || !user.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cfg = await getSubwaveConfig();
  const auth = subwaveAdminAuth(cfg);
  if (!auth) {
    return NextResponse.json(
      { error: "Sub/Wave server username/password not set (Admin → Sub/Wave Server)" },
      { status: 500 }
    );
  }

  if (!isAdmin) {
    // Solo check at fire time: more than one listener means company.
    // Unknown count fails closed for non-admins.
    try {
      const np = await fetch(`${cfg.apiUrl}/now-playing`, { signal: AbortSignal.timeout(8000) });
      const data = await np.json().catch(() => ({}));
      const current = data?.listeners?.current;
      if (typeof current !== "number" || current > 1) {
        return NextResponse.json(
          { error: "Someone else is listening — skip is disabled" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json({ error: "Could not verify listeners — try again" }, { status: 502 });
    }
  }

  try {
    const res = await fetch(`${cfg.apiUrl}/dj/skip`, {
      method: "POST",
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Failed to reach station backend" }, { status: 502 });
  }
}
