import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { stationTextNumber } from "@/lib/linq";
import { phoneStatus } from "@/lib/textline";
import { stationDialCode } from "@/lib/station-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Account panel's one read: link state, bells, and the transcript. */
export async function GET() {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [status, defaultCountry, textNumber] = await Promise.all([
    phoneStatus(me.id),
    stationDialCode(),
    // The number a listener has to text first, so the panel can link straight
    // into Messages instead of printing a number to copy.
    stationTextNumber(),
  ]);
  return NextResponse.json({ ...status, defaultCountry, textNumber });
}
