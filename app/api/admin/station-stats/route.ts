import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getStationStats, StationStatsDateError, validStationDate } from "@/lib/station-stats";
import type { StationStatsResponse } from "@/lib/station-stats-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req?: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const dates = req ? new URL(req.url).searchParams.getAll("date") : [];
  if (dates.length > 1 || (dates.length === 1 && !validStationDate(dates[0]))) {
    return NextResponse.json({ error: "Invalid station date." }, { status: 400, headers });
  }
  try {
    const stats: StationStatsResponse = await getStationStats({ date: dates[0] });
    return NextResponse.json(stats, { headers });
  } catch (error) {
    if (error instanceof StationStatsDateError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers });
    }
    throw error;
  }
}
