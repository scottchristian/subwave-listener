import { NextRequest, NextResponse } from "next/server";
import { deviceAuth } from "@/lib/device-auth";
import { buildDeviceState } from "@/lib/device-service";

/**
 * Everything the screen renders, in one payload.
 *
 * POLLED EVERY TEN SECONDS, so it stays small: the artwork and the avatar have
 * their own endpoints, and the schedule — which changes about once a day and is
 * comparatively large — is fetched separately and only when the shows window is
 * actually open. The server sends `pollAfterSec` so the rate can be tuned here
 * rather than compiled into firmware.
 *
 * The whole Skip button arrives as a finished label. The screen never reads
 * skipVisibility, never counts listeners to work out whether it may skip, and
 * therefore cannot show a control the server would refuse — the dead button that
 * lib/skipvisibility.ts exists to prevent.
 *
 * A device is never a user. This route resolves no session, reads no cookie, and
 * writes nothing.
 */
export async function GET(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json(
      { error: "This screen is not set up. Flash it again from the admin panel." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (authed.row.status === "revoked") {
    return NextResponse.json(
      { error: "This screen was removed from the station." },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const state = await buildDeviceState(authed.row);
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}