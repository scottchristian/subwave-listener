import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../auth/[...nextauth]/route";



export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.setting.findMany();
  return NextResponse.json(settings);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { key, value } = await req.json();
  
  if (!key || typeof value !== "string") {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }

  const setting = await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });

  // Mirror the maintenance switch locally the moment it is turned, not on the
  // next read. Turning maintenance ON is exactly when Postgres is most likely
  // to be the thing being worked on, so a mirror that only refreshed on read
  // would be the wrong way round: the save would succeed, and then the outage
  // that follows it would find the old value and carry on serving the station.

  // The lite cache keeps its switch in memory (reading it per request would
  // be the chatter it exists to avoid) — refresh on save so enabling applies
  // within the minute with no restart.
  if (key === "maintenanceMode" || key === "maintenanceMessage") {
    try {
      const { litePutSettings } = await import("@/lib/lite-cache");
      await litePutSettings({ [key]: value });
    } catch {}
  }

  if (key === "liteCacheEnabled" || key === "liteFlushMinutes") {
    try {
      const { refreshLiteConfig } = await import("@/lib/lite-cache");
      await refreshLiteConfig();
    } catch {}
  }

  return NextResponse.json(setting);
}
