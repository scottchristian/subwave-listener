import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import { displayName } from "@/lib/pii";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The operator's inbox: the most recent 200 bubbles across every listener. */
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await prisma.textMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      contact: {
        include: { user: { select: { name: true, nickname: true, image: true } } },
      },
    },
  });

  return NextResponse.json({
    messages: rows
      .slice()
      .reverse()
      .map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        phone: m.contact.phone,
        name: displayName(m.contact.user),
        image: m.contact.user.image || null,
      })),
  });
}
