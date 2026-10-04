import { NextResponse } from "next/server";
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
export async function GET() {
  // Checked before the cache so a listener cannot use this to probe the panel.
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  // Served from the shared hourly cache without touching the network — this is
  // the path that runs every time the admin page loads.
  const payload = await getUpdateStatus();
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
