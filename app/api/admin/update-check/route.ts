import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { getUpdateStatus } from "@/lib/update-check";

/**
 * "Is there an update on the operator's channel?" for the admin panel.
 *
 * Deliberately does NOT update anything (see the in-app updater routes for the
 * doing). Auth: admin only. It reveals nothing sensitive (a public repo's
 * version), but it is operator information and there is no reason to serve it
 * to listeners.
 */
export async function GET(req: NextRequest) {
  // Checked before the cache so a listener cannot use this to probe the panel.
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  // ?refresh=1 skips the hourly cache and asks GitHub now. The admin panel
  // sends it when the operator opens the System tab, so the update button
  // answers "right now" instead of "up to an hour ago". Everything else —
  // page load, scheduler — stays on the cache (60 req/hr per IP).
  const force = req.nextUrl.searchParams.get("refresh") === "1";
  const payload = await getUpdateStatus(force ? { force: true } : undefined);
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
