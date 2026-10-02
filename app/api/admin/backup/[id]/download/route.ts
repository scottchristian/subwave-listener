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
import { archiveBackup, removeArchive } from "@/lib/backup";
import { promises as fs } from "node:fs";

export async function GET(_req: Request, { params }: Params) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  const { id } = await params;
  try {
    const { filePath, fileName } = await archiveBackup(id);
    try {
      const buf = await fs.readFile(filePath);
      return new Response(buf as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Length": String(buf.length),
        },
      });
    } finally {
      await removeArchive(filePath);
    }
  } catch {
    return NextResponse.json({ error: "No such backup" }, { status: 404 });
  }
}
