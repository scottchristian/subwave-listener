import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../auth/[...nextauth]/route";
import { scheduleBounce } from "@/lib/pm2app";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return false;
  return true;
}

type Params = { params: Promise<{ id: string }> };
import { restoreBackup } from "@/lib/backup";

export async function POST(req: Request, { params }: Params) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  let confirm = false;
  try {
    confirm = (await req.json())?.confirm === true;
  } catch {
    // no body — treated as unconfirmed
  }
  try {
    const { tables } = await restoreBackup(id, confirm);
    // Env is back on disk but the running process already read the old one —
    // restart so the two agree. Delayed so this response reaches the browser.
    scheduleBounce(1500);
    return NextResponse.json({ ok: true, restarting: true, tables });
  } catch (e) {
    const msg = (e as Error)?.message || "restore failed";
    const status = msg.includes("confirmation") ? 400 : msg.includes("manifest") || msg.includes("bad backup") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
