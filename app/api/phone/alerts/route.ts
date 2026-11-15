import { NextResponse } from "next/server";
import { requireUser } from "@/lib/listener-auth";
import { setShowAlert } from "@/lib/textline";
import { linkErrorStatus } from "../status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A bell in the Shows panel. Only a verified, linked phone can hold one. */
export async function POST(req: Request) {
  const me = await requireUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const showId = typeof body?.showId === "string" ? body.showId.trim() : "";
  const enabled = body?.enabled === true;
  if (!showId) return NextResponse.json({ code: "invalid_show", message: "Unknown show." }, { status: 400 });

  const result = await setShowAlert(me.id, showId, enabled);
  if (!result.ok) {
    return NextResponse.json(
      { code: result.code || "not_linked", message: "Link your phone first." },
      { status: linkErrorStatus(result.code || "not_linked") }
    );
  }
  return NextResponse.json({ ok: true });
}
