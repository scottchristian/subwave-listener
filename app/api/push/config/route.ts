import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { vapidPublicKey } from "@/lib/push";

// VAPID public key for push subscription (avoids a NEXT_PUBLIC rebuild).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const publicKey = vapidPublicKey();
  if (!publicKey) {
    return NextResponse.json({ error: "Push not configured (VAPID keys)" }, { status: 500 });
  }
  return NextResponse.json({ publicKey });
}
