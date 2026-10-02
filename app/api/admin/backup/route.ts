import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { createBackup, listBackups } from "@/lib/backup";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return false;
  return true;
}

export async function GET() {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  return NextResponse.json({ backups: await listBackups() });
}

export async function POST(req: Request) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  let label = "";
  try {
    const body = await req.json();
    if (typeof body?.label === "string") label = body.label.slice(0, 80);
  } catch {
    // no body — unnamed backup
  }
  try {
    const backup = await createBackup(label);
    return NextResponse.json({ ok: true, backup });
  } catch (e) {
    return NextResponse.json({ error: `Backup failed: ${(e as Error)?.message || "unknown error"}` }, { status: 500 });
  }
}
