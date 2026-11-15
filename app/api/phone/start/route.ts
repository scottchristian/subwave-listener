import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { stationDialCode } from "@/lib/station-schedule";
import { startLink } from "@/lib/textline";
import { linkErrorStatus } from "../status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a code. The country code is the station's, not the browser's: a number
 * typed as 0408… is completed from the station's own timezone, so a listener
 * on holiday still links the phone they actually hold.
 */
export async function POST(req: Request) {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const phone = typeof body?.phone === "string" ? body.phone : "";

  const country = await stationDialCode();
  if (!country) {
    return NextResponse.json(
      { code: "no_country", message: "We couldn't work out the country code. Enter your number with +61 at the front." },
      { status: 400 }
    );
  }

  const result = await startLink(me.id, phone, { defaultCountry: country });
  if (!result.ok) return NextResponse.json(result, { status: linkErrorStatus(result.code) });
  return NextResponse.json({ ok: true });
}
