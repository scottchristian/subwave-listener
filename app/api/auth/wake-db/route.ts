import { NextResponse } from "next/server";
import { wakeDbForRequest } from "@/lib/dbwake";

export async function POST() {
  const { woke, diagnosis } = await wakeDbForRequest(15_000);
  // diagnosis.summary is public-safe by construction — no URLs, no credentials.
  return NextResponse.json({ woke, ...(diagnosis ? { diagnosis } : {}) });
}