import { NextResponse } from "next/server";
import { wakeDbForRequest } from "@/lib/dbwake";

export async function POST() {
  const woke = await wakeDbForRequest(15_000);
  return NextResponse.json({ woke });
}