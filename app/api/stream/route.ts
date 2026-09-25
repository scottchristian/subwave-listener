export const runtime = 'nodejs';

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";
import { getSubwaveConfig } from "@/lib/subwave";
import http from "http";

export async function GET(req: NextRequest) {
  // Validate session
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Validate approval
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user?.isApproved) {
    return new Response("Forbidden: Account pending approval.", { status: 403 });
  }

  const cfg = await getSubwaveConfig();
  const streamUrl = cfg.streamUrl;
  if (!streamUrl) {
    return new Response("Stream relay not configured (Admin → Sub/Wave Server)", { status: 500 });
  }

  // Fetch the station password from settings
  const stationPassword = cfg.stationPassword;

  // Log the session start
  const streamSession = await prisma.streamSession.create({
    data: {
      userId: user.id,
      startTime: new Date(),
    }
  });

  const targetUrl = new URL(streamUrl);
  targetUrl.searchParams.set("auth", stationPassword);

  try {
    const clientIp = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
    const userAgent = req.headers.get("user-agent") || `${STATION.name}-Proxy/1.0`;
    
    const upstreamRes = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent": userAgent,
        "X-Forwarded-For": clientIp,
      },
      // Ensure we don't buffer the response
      cache: "no-store",
      signal: req.signal,
    });

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 401) {
        console.error("\n=======================================================\nCRITICAL ERROR: Stream proxy failed with 401 Unauthorized!\nThe Station Password in Admin Settings is likely incorrect or missing.\nPlease update it in the Admin Dashboard.\n=======================================================\n");
      }
      return new Response(`Upstream Error: ${upstreamRes.statusText}`, { status: upstreamRes.status });
    }

    // We intercept the stream to track disconnects
    const reader = upstreamRes.body?.getReader();
    if (!reader) {
      return new Response("Failed to get stream reader", { status: 500 });
    }

    const onDisconnect = async () => {
      // Prevent double-logging
      if ((streamSession as any).endTime) return;
      
      const endTime = new Date();
      (streamSession as any).endTime = endTime; // mark locally
      const durationSec = Math.floor((endTime.getTime() - streamSession.startTime.getTime()) / 1000);
      try {
        await prisma.streamSession.update({
          where: { id: streamSession.id },
          data: { endTime, durationSec },
        });
      } catch (e) {
        console.error("Failed to update stream session", e);
      }
    };

    req.signal.addEventListener("abort", () => {
      console.log("Client aborted request");
      onDisconnect();
      reader.cancel();
    });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            if (req.signal.aborted) {
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          // Client disconnected
        } finally {
          await onDisconnect();
          try { controller.close(); } catch(e) {}
        }
      },
      cancel() {
        console.log("Stream cancelled by client");
        onDisconnect();
        reader.cancel();
      }
    });

    // Forward headers to Safari to correctly identify as a stream
    const resHeaders = new Headers();
    resHeaders.set("Content-Type", "audio/mpeg");
    resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
    resHeaders.set("Accept-Ranges", "none");
    
    // Copy Icecast icy-* headers so Safari doesn't treat this as a static file
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.toLowerCase().startsWith("icy-")) {
        resHeaders.set(key, value);
      }
    }

    return new Response(stream, { headers: resHeaders });
  } catch (error) {
    console.error("Fetch to stream URL failed", error);
    return new Response("Proxy error", { status: 502 });
  }
}
