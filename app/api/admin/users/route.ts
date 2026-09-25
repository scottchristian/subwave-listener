import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../auth/[...nextauth]/route";



export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      streamSessions: true,
      donations: true,
    }
  });

  const formattedUsers = users.map(user => {
    const totalDurationSec = user.streamSessions.reduce((acc, curr) => acc + (curr.durationSec || 0), 0);
    const totalDonations = user.donations.reduce((acc, curr) => acc + curr.amount, 0);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isApproved: user.isApproved,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
      totalDurationSec,
      totalDonations,
    };
  });

  return NextResponse.json(formattedUsers);
}
