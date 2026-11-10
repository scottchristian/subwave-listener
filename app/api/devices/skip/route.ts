import { NextRequest, NextResponse } from "next/server";
import { deviceAuth } from "@/lib/device-auth";
import { canSkipAsScreen, parseSkipVisibility, parseSkipVisibilityScreens } from "@/lib/skipvisibility";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

/**
 * Skip, from a wall-mounted screen.
 *
 * THE TENSION THIS ROUTE RESOLVES. A screen must be able to skip, because that
 * is what the listener experience does and the screen is a thin client of the
 * same thing. It must also NEVER register as a signed-in listener, or it would
 * inflate the count the station publishes about itself. The obvious
 * implementation — reuse the listener skip route with a session — satisfies one
 * and breaks the other, and breaks it silently: the station's own numbers stop
 * adding up and nobody can say why.
 *
 * So: the screen is its own class. It authenticates with its own bearer token,
 * forwards using STATION admin credentials rather than anybody's session, and is
 * gated by the same canSkipAsListener the player reads — via canSkipAsScreen,
 * which layers the device-specific setting on top. One policy, one module, two
 * call sites that cannot disagree.
 *
 * NEVER ADMIN TIER. "Never play this track", "DJ say" and the on-air controls are
 * not reachable from here and never will be: provisioning is admin-only, and that
 * authorises creating the row and nothing after it. check-device-skip.mts fails
 * the build if either of those ever appears.
 */
export async function POST(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json({ error: "This screen is not set up." }, { status: 401 });
  }

  const cfg = await getSubwaveConfig();
  const stationAuth = subwaveAdminAuth(cfg);
  if (!stationAuth) {
    return NextResponse.json(
      { error: "The station's Sub/Wave credentials are not set. Add them under Admin, then Sub/Wave Server." },
      { status: 500 },
    );
  }

  // Read both policy settings. A read failure must NOT fail open — it falls
  // through to solo/follow, which hides the control rather than offering one the
  // server would refuse a second later.
  let mode = "solo" as import("@/lib/skipvisibility").SkipVisibility;
  let screens = "follow" as import("@/lib/skipvisibility").SkipVisibilityScreens;
  try {
    const rows = await (await import("@/lib/prisma")).default.setting.findMany({
      where: { key: { in: ["skipVisibility", "skipVisibilityScreens"] } },
      select: { key: true, value: true },
    });
    mode = parseSkipVisibility(rows.find((r) => r.key === "skipVisibility")?.value);
    screens = parseSkipVisibilityScreens(rows.find((r) => r.key === "skipVisibilityScreens")?.value);
  } catch {
    return NextResponse.json({ error: "Could not read the station's skip settings." }, { status: 502 });
  }

  const deviceEnabled = authed.row.skipEnabled !== "0";
  const allowed = canSkipAsScreen(screens, mode, null, deviceEnabled);
  if (!allowed) {
    return NextResponse.json(
      { error: "Skip is not available on this screen right now." },
      { status: 403 },
    );
  }

  // Solo check at fire time, exactly as the listener route does it: by the moment
  // a finger lands on the wall, the room may have filled up.
  if (mode === "solo") {
    try {
      const np = await fetch(`${cfg.apiUrl}/now-playing`, { signal: AbortSignal.timeout(8000) });
      const data = await np.json().catch(() => ({}));
      const current = data?.listeners?.current;
      // Unknown count fails closed. A wall screen should not cut the music
      // because it could not find out whether anyone is listening.
      if (typeof current !== "number" || current > 1) {
        return NextResponse.json(
          { error: "Somebody else is listening." },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Could not check who is listening. Try again." }, { status: 502 });
    }
  }

  try {
    const res = await fetch(`${cfg.apiUrl}/dj/skip`, {
      method: "POST",
      headers: { Authorization: stationAuth },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not reach the station backend." }, { status: 502 });
  }
}