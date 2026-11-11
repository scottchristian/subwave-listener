import { NextRequest, NextResponse } from "next/server";
import { deviceAuth } from "@/lib/device-auth";
import { readActiveArtifact } from "@/lib/firmware-ota";

/**
 * The image for this screen's own accepted install.
 *
 * THE URL HAS NO PARAMETERS AND NO PATH TO CHOOSE. The device presents its bearer
 * token; the server resolves the one live attempt that token owns and streams the
 * release pinned by it. There is nothing to tamper with: no release id a screen
 * could swap for another device's build, no filename, no query string. A revoked
 * device is refused (401), a device with no live attempt gets 409, and a pinned
 * release whose bytes are gone or damaged gets 410 rather than a short file that
 * a bootloader would happily half-flash.
 *
 * The bytes are returned exactly as stored, with an exact Content-Length and the
 * version/sha256 the screen should check them against. The token is only ever in
 * the Authorization header — never a URL, never a log line.
 */
export async function GET(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json(
      { error: "This screen is not set up." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Refuse a query rather than ignore it: the contract is a fixed resource, and
  // accepting ?release= silently would invite a caller to believe it worked.
  if (req.nextUrl.search) {
    return NextResponse.json(
      { error: "This endpoint takes no parameters." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await readActiveArtifact(authed.row);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new NextResponse(new Uint8Array(result.bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(result.bytes.length),
      "Cache-Control": "no-store",
      "X-Firmware-Version": result.release.version,
      "X-Firmware-Sha256": result.release.sha256,
    },
  });
}
