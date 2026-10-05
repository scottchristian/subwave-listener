import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { dbQueryStats, readQueryAudit } from "@/lib/prisma";

/**
 * What this process has asked the database since boot, per table. When the
 * provider dashboard says Running but nobody is here, this names the exact
 * query that did it — counts and timestamps only, no rows, no args.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ ...dbQueryStats(), recent: readQueryAudit().slice(-20), now: new Date().toISOString() });
}
