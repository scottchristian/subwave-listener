import path from "node:path";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { maskDatabaseUrl, otherProvider, providerFromEnv } from "@/lib/db-provider";
import { grantSql } from "@/lib/pg-probe";
import { activeListeners } from "@/lib/listeners";

// Which database is live, what a move would carry, and whether the room is clear
// enough to start one. Read-only: this endpoint never connects to the target, it
// only reports state and hands back the grant block for the operator to run as a
// superuser.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const provider = providerFromEnv();
  const target = otherProvider(provider);

  // Row counts, so the panel can show what a copy would move.
  let counts: Record<string, number> = {};
  let liveError: string | null = null;
  try {
    const { default: prisma } = await import("@/lib/prisma");
    const [users, sessions, streams, requests, likes, donations, settings] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.streamSession.count(),
      prisma.songRequest.count(),
      prisma.songLike.count(),
      prisma.donation.count(),
      prisma.setting.count(),
    ]);
    counts = { users, sessions, streams, requests, likes, donations, settings };
  } catch (e: any) {
    liveError = String(e?.message || e).trim().split("\n")[0];
  }

  // Is anyone listening? The move flow greys its button out on this rather than
  // letting the operator start a migration that is bound to be refused. Null
  // means we could not tell — which is treated as "do not offer it", matching
  // how the copy routes already fail closed on an unreadable listener query.
  let listeners: { userId: string; name: string; since: string }[] | null = null;
  try {
    listeners = await activeListeners();
  } catch {
    listeners = null;
  }

  return NextResponse.json({
    provider,
    target,
    // Where the data lives now. Masked: this is what the UI displays.
    currentUrl: maskDatabaseUrl(process.env.DATABASE_URL),
    // The configured Postgres URL is stored encrypted at rest; whether it is
    // configured is enough for this screen. The panel asks for the URL when
    // probing rather than holding it in the database and shipping it around.
    hasTarget: provider === "sqlite",
    counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    liveError,
    listeners,
    listenerCount: listeners?.length ?? null,
    // Where a revert would write by default. Offered so the operator does not
    // have to invent an absolute path, and dated so it can never collide with
    // the live file or a previous copy — the copy refuses to overwrite.
    suggestedSqliteFile: (() => {
      const d = new Date();
      const stamp =
        d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0") +
        "-" +
        String(d.getHours()).padStart(2, "0") +
        String(d.getMinutes()).padStart(2, "0");
      return path.join(process.cwd(), "data", `subwave-${stamp}.db`);
    })(),
    grantHint: grantSql("<role>", "<database>"),
  });
}
