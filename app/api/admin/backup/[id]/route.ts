import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { scheduleBounce } from "@/lib/pm2app";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return false;
  return true;
}

type Params = { params: Promise<{ id: string }> };
import { deleteBackup } from "@/lib/backup";

export async function DELETE(_req: Request, { params }: Params) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  try {
    await deleteBackup(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No such backup" }, { status: 404 });
  }
}
