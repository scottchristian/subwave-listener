import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("x-station-auth");
  const urlParams = new URL(req.url).searchParams;
  const paramAuth = urlParams.get("auth");

  if (auth !== process.env.STATION_PASSWORD && paramAuth !== process.env.STATION_PASSWORD) {
     return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  const limit = parseInt(urlParams.get("limit") || "10", 10);

  const donations = await prisma.donation.findMany({
    take: limit,
    orderBy: { receivedAt: 'desc' },
    select: {
      id: true,
      supporterName: true,
      supporterEmail: true,
      amount: true,
      currency: true,
      message: true,
      receivedAt: true,
    }
  });
  
  return NextResponse.json({ success: true, data: donations });
}
