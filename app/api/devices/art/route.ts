import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { deviceAuth } from "@/lib/device-auth";
import { getSubwaveConfig } from "@/lib/subwave";

/**
 * Album art, resized for a panel that decodes it into a fixed RGB565 buffer.
 *
 * WHY A PROXY RATHER THAN THE BACKEND'S URL. The backend serves full-size covers
 * — around 40-75KB each, and much larger for a high-resolution scan. A screen
 * pulls one over its own WiFi and decodes it into a 520x520 buffer, so every
 * unnecessary pixel is radio time it does not need to spend. Resizing here also
 * keeps the backend's address off the device entirely.
 *
 * 640 rather than 520 leaves headroom, so a future panel revision with a sharper
 * panel or a slightly larger artwork tile does not need the contract changing.
 *
 * Cached hard and immutably, because the URL is stable per track — the same
 * treatment public/sw.js already gives these covers in the browser.
 */
const EDGE = 640;
const QUALITY = 82;

export async function GET(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json({ error: "This screen is not set up." }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: "No track was asked for." }, { status: 400 });
  }

  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) return NextResponse.json({ error: "The station backend is not reachable." }, { status: 503 });

  try {
    const res = await fetch(`${cfg.apiUrl}/cover/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return NextResponse.json({ error: "No artwork for that track." }, { status: 404 });

    const upstream = Buffer.from(await res.arrayBuffer());
    // fit: 'cover' matches the player's object-fit: cover, so the artwork sits in
    // the same square crop it does on the web rather than letterboxing differently.
    const resized = await sharp(upstream).resize(EDGE, EDGE, { fit: "cover" }).jpeg({ quality: QUALITY }).toBuffer();

    return new NextResponse(new Uint8Array(resized), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(resized.length),
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "The station backend did not answer." }, { status: 504 });
  }
}