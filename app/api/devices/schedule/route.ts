import { NextRequest, NextResponse } from "next/server";
import { deviceAuth } from "@/lib/device-auth";
import { buildDeviceSchedule } from "@/lib/device-service";

/**
 * The show list, already merged, already formatted, already in station time.
 *
 * ALL THE DATE MATHS HAPPENS HERE. Consecutive identical days collapse into one
 * run, consecutive hours running the same show collapse into one slot, and every
 * time is formatted in the station's own zone. A firmware implementation of any
 * of that would be a second place for the same rules to be wrong, and the whole
 * reason the player and the wall agree today is that there is only one
 * implementation.
 *
 * "Now and next" only — no day navigation. A wall display answers what is on; the
 * browsable week stays one tap away in the browser.
 *
 * An empty slot is the station running itself, which the web player calls Auto DJ
 * and gives the station logo as its avatar. The screen does the same by sending no
 * avatar, so it renders the logo itself.
 */
export async function GET(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json(
      { error: "This screen is not set up." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const schedule = await buildDeviceSchedule();
  return NextResponse.json(schedule, { headers: { "Cache-Control": "no-store" } });
}