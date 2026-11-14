import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { wakeDbForRequest } from "@/lib/dbwake";
import { statusFromProbe, type StationStatusPayload } from "@/lib/station-status";

export const dynamic = "force-dynamic";

// Where deploy.sh declares an in-flight deploy. data/ is excluded from the
// rsync sync, so the flag survives the very deploy that writes it.
const MAINTENANCE_FILE = path.join(process.cwd(), "data", "maintenance.json");

// Many unauthenticated browsers can poll this at once; a short cache keeps
// that from becoming many database connections per second.
const CACHE_MS = 5_000;
let cache: { at: number; payload: StationStatusPayload } | null = null;

async function computeStatus(): Promise<StationStatusPayload> {
  let maintenanceFlagPresent = false;
  try {
    maintenanceFlagPresent = fs.existsSync(MAINTENANCE_FILE);
  } catch {
    maintenanceFlagPresent = false;
  }
  // A short knock is enough: this endpoint classifies, it does not wake.
  // 3s keeps the answer honest without letting a slow probe pile up polls.
  const { woke, diagnosis } = await wakeDbForRequest(3_000);
  return statusFromProbe({ maintenanceFlagPresent, woke, diagnosis });
}

export async function GET() {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), payload: await computeStatus() };
  }
  return NextResponse.json(cache.payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
