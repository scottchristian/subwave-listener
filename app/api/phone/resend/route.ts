import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { resendLinkCode } from "@/lib/textline";
import { linkErrorStatus } from "../status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send the live bind code again. Valid only after a first code went out — that
 * send opened the chat, so this is an ordinary reply, not a cold first text.
 */
export async function POST() {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await resendLinkCode(me.id);
  if (!result.ok) return NextResponse.json(result, { status: linkErrorStatus(result.code) });
  return NextResponse.json({ ok: true });
}
