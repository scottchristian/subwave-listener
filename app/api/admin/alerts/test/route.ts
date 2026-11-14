import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { notifyAdmins } from "@/lib/ntfy";
import { STATION } from "@/lib/station";

export const runtime = "nodejs";

// Send a real test alert so the operator can confirm the phone end works
// before relying on it. await is fine here: the whole point is the answer.
export async function POST() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const sent = await notifyAdmins(
    "Test alert",
    `${STATION.name}: ntfy is working — this is a test alert from the admin panel.`,
    { priority: 3, tags: ["white_check_mark"] }
  );
  if (!sent) {
    return NextResponse.json(
      {
        error:
          "The test alert could not be sent. Check that alerts are enabled, the topic is right, and the token (if any) is valid.",
      },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}
