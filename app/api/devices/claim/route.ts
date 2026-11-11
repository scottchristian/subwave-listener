import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consumeClaimToken, mintDeviceToken, hashToken } from "@/lib/device-auth";

/**
 * A screen claims itself with the token compiled into its firmware.
 *
 * THERE IS NO "FINISH SETUP" PAGE IN THE APP. It would be the obvious place to
 * complete this — the operator is already signed in, so it could exchange a claim
 * for a device token using their session. That is exactly the coupling this
 * whole design refuses: the screen would then hold a credential minted from a
 * person's login, and its access would live or die with their account. Instead
 * the device posts here itself, and the operator's session plays no part beyond
 * having flashed the binary in the first place.
 *
 * Failures are answered separately because they mean different things to whoever
 * is holding the panel: never flashed, already claimed by this screen, expired,
 * or a token from a different build.
 *
 * A device is never a user. Nothing here reads a session or a cookie, and
 * check-device-isolation.mts fails the build if that ever changes.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send the claim as JSON." }, { status: 400 });
  }

  const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
  const claimToken = typeof body?.claimToken === "string" ? body.claimToken.trim() : "";
  if (!deviceId || !claimToken) {
    return NextResponse.json({ error: "Send the screen's id and its setup code." }, { status: 400 });
  }

  const consumed = await consumeClaimToken(deviceId, claimToken);
  if (!consumed.ok) {
    if (consumed.reason === "unknown") {
      return NextResponse.json(
        { error: "No screen is set up with that code. Flash it from the admin panel first." },
        { status: 404 },
      );
    }
    if (consumed.reason === "used") {
      return NextResponse.json(
        { error: "This screen is already set up." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "That setup code has expired. Generate a new one and rebuild the screen." },
      { status: 410 },
    );
  }

  // The claim token is burned here, in the same breath as minting the real one:
  // a replay of the same pair finds nothing, because the stored hash is cleared.
  const token = await mintDeviceToken(consumed.row);

  // Setup captured here, opportunistically and never blocking a claim. The
  // captive portal page sends the browser's own timezone and a geolocation the
  // person granted, which is why neither is ever typed.
  const patch: Record<string, unknown> = { status: "claimed" };
  const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  // Validate the shape rather than trusting it: this string ends up in a file
  // that a build step will read.
  if (tz && /^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(tz)) patch.timezone = tz;

  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    patch.lat = lat;
    patch.lon = lon;
    if (body.saveAsStationDefault === true) {
      // The first screen offered becomes the station default, so screens two and
      // three inherit it and only ever ask once.
      await prisma.setting
        .upsert({ where: { key: "stationLat" }, update: { value: String(lat) }, create: { key: "stationLat", value: String(lat) } })
        .catch(() => {});
      await prisma.setting
        .upsert({ where: { key: "stationLon" }, update: { value: String(lon) }, create: { key: "stationLon", value: String(lon) } })
        .catch(() => {});
    }
  }

  const updated = await prisma.device.update({ where: { id: consumed.row.id }, data: patch });

  return NextResponse.json(
    {
      token,
      settingsRev: updated.settingsRev,
      pollAfterSec: 10,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}