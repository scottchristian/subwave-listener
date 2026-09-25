import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

// Mint a fresh VAPID pair for review. NOT saved — Save Keys persists.
// Rotating orphans existing devices until they re-subscribe.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const webpush = (await import("web-push")) as typeof import("web-push");
    const keys = webpush.generateVAPIDKeys();
    if (!keys?.publicKey || !keys?.privateKey) throw new Error("empty keys");
    return NextResponse.json({ ok: true, ...keys });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Generation failed" }, { status: 500 });
  }
}
