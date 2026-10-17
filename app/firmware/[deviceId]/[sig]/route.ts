import { NextRequest, NextResponse } from "next/server";
import { readFirmware, verifyFirmwarePart } from "@/lib/firmware-upload";

/**
 * The firmware binary itself, behind a signature instead of a session.
 *
 * WHY THIS IS PUBLIC. It has to be: esp-web-tools fetches the manifest's part
 * itself, and whether it carries cookies is that tool's business rather than
 * ours. Rather than bet the flash on it, the part URL is signed and expires in
 * ten minutes, so the request is self-proving whether or not a cookie comes with
 * it. The flash works either way, which is the point.
 *
 * WHY THAT IS SAFE. The path is unguessable (an HMAC over the device id and an
 * expiry) and short-lived, exactly like a password reset link — and it is a
 * bearer secret only for as long as it takes to flash a screen. The manifest
 * that mints it is session-gated, and revoking a screen deletes the file as well
 * as the row, because a revoked screen's binary still carries a working claim
 * token.
 *
 * The expiry is checked against the CLOCK and the signature is over the expiry the
 * caller is actually claiming, not over one read from the query string — an
 * attacker controls that parameter, so verifying a signature over a value they
 * supplied and then trusting a different one would be no check at all.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ deviceId: string; sig: string }> }) {
  const { deviceId, sig } = await ctx.params;
  const exp = Number(req.nextUrl.searchParams.get("exp"));

  let ok = false;
  try {
    ok = verifyFirmwarePart(deviceId, sig.replace(/\.bin$/, ""), exp);
  } catch {
    ok = false;
  }
  if (!ok) {
    return new NextResponse("This download link has expired. Reload the page and try again.", { status: 403 });
  }

  const bytes = await readFirmware(deviceId);
  if (!bytes) return new NextResponse("No firmware for that screen.", { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      // Immutable because the content behind a signature cannot change: minting a
      // new one for a rebuild produces a new signature, not a new body.
      "Cache-Control": "private, max-age=600, immutable",
    },
  });
}