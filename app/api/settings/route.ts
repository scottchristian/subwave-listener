import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";



export async function GET() {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["donate_url", "donate_text", "donate_enabled"] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    return NextResponse.json({
      donate_url: get("donate_url") || STATION.donateUrl,
      donate_text: get("donate_text") || undefined,
      donate_enabled: (get("donate_enabled") ?? "true") !== "false",
    });
  } catch (error) {
    return NextResponse.json({ donate_url: STATION.donateUrl, donate_enabled: true });
  }
}
