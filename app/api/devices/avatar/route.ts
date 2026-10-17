import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { deviceAuth } from "@/lib/device-auth";
import { getSubwaveConfig } from "@/lib/subwave";

/**
 * A persona's face, small enough to draw in a list row.
 *
 * ONLY FETCHED WHEN A SHOW LIST ROW IS EXPANDED — the same rule the web player
 * uses, where avatars live inside the accordion rather than on every row. A wall
 * display showing six rows therefore costs zero requests until somebody touches
 * one, which matters when the whole point of a list is to be glanceable.
 *
 * THE /api PREFIX IS THE WHOLE TRICK. The schedule feed gives an avatar as
 * `/persona-avatar/<id>`, and that path 404s. The working path is
 * `/api/persona-avatar/<id>`. getAvatarSrc (app/page.tsx:2203) adds the prefix
 * before building a URL; this route does the same, because a screen that renders
 * six broken images is worse than one that renders six blank rows.
 */
const EDGE = 128;

export async function GET(req: NextRequest) {
  const authed = await deviceAuth(req);
  if (!authed) {
    return NextResponse.json({ error: "This screen is not set up." }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: "No persona was asked for." }, { status: 400 });
  }

  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) return NextResponse.json({ error: "The station backend is not reachable." }, { status: 503 });

  try {
    const res = await fetch(`${cfg.apiUrl}/api/persona-avatar/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    // A persona with no uploaded image is ordinary, not an error. The screen
    // renders the row without one, so this must not be noisy or fatal.
    if (!res.ok) return NextResponse.json({ error: "No picture for that person." }, { status: 404 });

    const upstream = Buffer.from(await res.arrayBuffer());
    const resized = await sharp(upstream).resize(EDGE, EDGE, { fit: "cover" }).png().toBuffer();

    return new NextResponse(new Uint8Array(resized), {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(resized.length),
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "The station backend did not answer." }, { status: 504 });
  }
}