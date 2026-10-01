import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { getSubwaveConfig } from "@/lib/subwave";



export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: session.user.email }
    });

    if (!user || !user.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { track, name } = await req.json();

    if (!track) {
      return NextResponse.json({ error: "Track is required" }, { status: 400 });
    }

    // Anti-spam: one request per user per 30s. The client cools the button
    // down too, but only this survives curl.
    const REQUEST_COOLDOWN_MS = 30_000;
    const last = await prisma.songRequest.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last) {
      const waitMs = REQUEST_COOLDOWN_MS - (Date.now() - new Date(last.createdAt).getTime());
      if (waitMs > 0) {
        return NextResponse.json(
          { error: `Booth needs a breather — try again in ${Math.ceil(waitMs / 1000)}s.`, retryAfterSec: Math.ceil(waitMs / 1000) },
          { status: 429 }
        );
      }
    }

    // Save to the database
    await prisma.songRequest.create({
      data: {
        userId: user.id,
        song: track,
        nameUsed: name || "Anonymous Listener",
      }
    });

    // Proxy the request to the Subwave backend (address + station password
    // from Admin → Sub/Wave Server settings).
    const cfg = await getSubwaveConfig();
    console.log("Forwarding request to Subwave Host:", { track, name: name || "Anonymous Listener" });
    const res = await fetch(`${cfg.apiUrl}/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-station-auth": cfg.stationPassword
      },
      body: JSON.stringify({
        text: track,
        name: name || "Anonymous Listener",
      })
    });

    const data = await res.json();
    console.log("Subwave Host response:", { status: res.status, data });
    return NextResponse.json(data);

  } catch (error) {
    console.error("Error submitting request:", error);
    return NextResponse.json({ error: "Failed to submit request" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: "Request ID is required" }, { status: 400 });
  }

  try {
    const cfg = await getSubwaveConfig();
    const res = await fetch(`${cfg.apiUrl}/request/${id}`, {
      method: "GET",
      headers: {
        "x-station-auth": cfg.stationPassword
      }
    });

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching request status:", error);
    return NextResponse.json({ error: "Failed to fetch request status" }, { status: 500 });
  }
}
