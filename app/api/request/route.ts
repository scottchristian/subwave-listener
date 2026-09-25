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
