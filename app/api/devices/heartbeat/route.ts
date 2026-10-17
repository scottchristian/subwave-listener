import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { completeRotation, deviceAuth } from "@/lib/device-auth";
import { applyDeviceSettings, deviceSettingsOf } from "@/lib/device-service";

/**
 * A screen reports in, and is told what to do.
 *
 * THE ONLY ENDPOINT THAT MAKES A DEVICE WRITE TO THE DATABASE. It carries status
 * up (last seen, firmware, signal) and settings down. Settings ride the heartbeat
 * rather than having an endpoint of their own, because a screen already talks to
 * us every sixty seconds and one round trip is one less thing to get wrong.
 *
 * THE ROTATION HANDOFF LIVES HERE. A screen holds its token in flash, so rotating
 * the stored hash strands it: it authenticates with the very token being
 * replaced and so cannot be handed a new one. The grace window in
 * lib/device-auth.ts keeps the old token working long enough for this response to
 * carry the new one, which the device writes over the top. Outside the window no
 * rotatedToken is sent, and once acknowledged the old hash is cleared for good.
 *
 * A device is never a user. Nothing here reads a session, a cookie, or a User,
 * and nothing here touches the presence map — a heartbeat is not a listener
 * being online. check-device-isolation.mts enforces all of that.
 */

export async function POST(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json(
      { error: "This screen is not set up. Flash it again from the admin panel." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { row, viaRotation } = authed;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // A heartbeat with an unreadable body is still a heartbeat: the screen is
    // alive and that is the useful fact. Carry on with the defaults.
  }

  const now = new Date();
  const firmwareVer = typeof body.firmwareVer === "string" ? body.firmwareVer.slice(0, 32) : null;
  const rssi = Number.isFinite(Number(body.rssi)) ? Math.round(Number(body.rssi)) : null;
  const ip = typeof body.ip === "string" ? body.ip.slice(0, 45) : null;
  const orientation = body.orientation === "portrait" ? "portrait" : "landscape";

  // Settings the device changed locally. A wall display nobody is watching still
  // has to be able to have its brightness adjusted from its own screen, and
  // that change has to reach the admin panel or the two quietly disagree.
  let applied = deviceSettingsOf(row);
  let settingsRev = row.settingsRev;
  if (body.settings && typeof body.settings === "object") {
    const result = await applyDeviceSettings(row, body.settings);
    applied = result.settings;
    settingsRev = result.settingsRev;
  }

  const updated = await prisma.device.update({
    where: { id: row.id },
    data: {
      status: "active",
      lastSeenAt: now,
      ...(firmwareVer ? { firmwareVer } : {}),
      ...(rssi !== null ? { rssi } : {}),
      ...(ip ? { ip } : {}),
      orientation,
      appliedRev: Number.isFinite(Number(body.appliedRev)) ? Math.round(Number(body.appliedRev)) : null,
      settingsRev,
    },
  });

  // A screen authenticating on a grace token is collecting a rotation. Mint the
  // replacement and hand it over here — the only moment after first issue that a
  // device token is ever returned. completeRotation clears the grace hash in the
  // same write, so the old token dies the instant this response lands.
  const rotatedToken = viaRotation ? await completeRotation(updated) : null;

  return NextResponse.json(
    {
      settings: deviceSettingsOf(updated),
      settingsRev: updated.settingsRev,
      nextHeartbeatSec: 60,
      ...(rotatedToken ? { rotatedToken } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}