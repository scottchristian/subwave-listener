import { NextRequest, NextResponse } from "next/server";
import { bindDevice } from "@/lib/device-auth";

// Thin wrapper: the logic lives in lib/device-auth.ts so check-device-routes can
// run it against a real database. See bindDevice for why the row must keep only
// the hash of the claim token.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const result = await bindDevice(typeof body?.bindCode === "string" ? body.bindCode : "");

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(
    {
      deviceId: result.deviceId,
      claimToken: result.claimToken,
      claimExpiresAt: result.claimExpiresAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
