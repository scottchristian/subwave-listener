import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";
import { parseSkipVisibility } from "@/lib/skipvisibility";

// Listener-facing skip. Visibility is an operator setting with three modes
// (see lib/skipvisibility.ts): hidden, solo-only, or always. Admins bypass all
// three — an operator needs Skip regardless. The backend has no listener skip,
// so this route decides, then forwards with station admin credentials.
//
// This is the enforcement point. The player hides the button to keep the UI
// honest, but a hidden control is not a refused request, so the decision has to
// be made here too — and it has to read the same helper the player does.
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
    // Read the operator's setting. A read failure must not fall open — an
    // unknown mode parses as "solo", the most restrictive live behaviour.
    let mode = parseSkipVisibility(null);
    try {
      const row = await prisma.setting.findUnique({
        where: { key: "skipVisibility" },
        select: { value: true },
      });
      mode = parseSkipVisibility(row?.value);
    } catch {
      return NextResponse.json({ error: "Could not read station settings" }, { status: 502 });
    }

    if (mode === "hidden") {
      return NextResponse.json(
        { error: "Skip is turned off for listeners" },
        { status: 403 }
      );
    }

    if (mode === "solo") {
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
    // "always": no headcount check. The player still confirms with the listener
    // before it gets here, but that is a UI courtesy, not a guarantee — so this
    // route deliberately lets it through rather than pretending to enforce it.
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
