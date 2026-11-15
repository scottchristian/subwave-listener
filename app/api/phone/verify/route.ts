import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { verifyLink } from "@/lib/textline";
import { linkErrorStatus } from "../status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prove the code. Success means the phone is linked and the welcome is out. */
export async function POST(req: Request) {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const code = typeof body?.code === "string" ? body.code : "";

  const result = await verifyLink(me.id, code);
  if (!result.ok) return NextResponse.json(result, { status: linkErrorStatus(result.code) });
  return NextResponse.json({ ok: true });
}
