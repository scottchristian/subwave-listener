import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { unlinkPhone } from "@/lib/textline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unlink and erase. This is deliberately one call with no "are you sure" on
 * the server: the confirm lives in the UI, and the deletion is the promise
 * the UI just made.
 */
export async function POST() {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await unlinkPhone(me.id);
  return NextResponse.json({ ok: true });
}
