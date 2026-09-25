import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";



export async function GET() {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: "donate_url" } });
    return NextResponse.json({ donate_url: setting?.value || STATION.donateUrl });
  } catch (error) {
    return NextResponse.json({ donate_url: STATION.donateUrl });
  }
}
