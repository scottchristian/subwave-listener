import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";

export async function GET() {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["donate_url", "donate_text", "donate_enabled", "streamMode", "stationPassword"] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    // Station password only rides along for approved sessions — direct mode
    // embeds it in the audio URL, and it must never leak to strangers.
    let stationPassword: string | undefined;
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.email) {
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (user?.isApproved) stationPassword = get("stationPassword") || undefined;
      }
    } catch {}
    return NextResponse.json({
      donate_url: get("donate_url") || STATION.donateUrl,
      donate_text: get("donate_text") || undefined,
      donate_enabled: (get("donate_enabled") ?? "true") !== "false",
      streamMode: get("streamMode") === "direct" ? "direct" : "relay",
      ...(stationPassword ? { stationPassword } : {}),
    });
  } catch (error) {
    return NextResponse.json({ donate_url: STATION.donateUrl, donate_enabled: true, streamMode: "relay" });
  }
}
