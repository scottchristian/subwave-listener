import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";



export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  let dateFilter = {};
  if (from || to) {
    dateFilter = {
      receivedAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      }
    };
  }

  const donations = await prisma.donation.findMany({
    where: dateFilter,
    orderBy: { receivedAt: 'desc' },
    include: {
      user: {
        select: { name: true, email: true }
      }
    }
  });

  return NextResponse.json(donations);
}
