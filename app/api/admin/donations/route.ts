import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { dec, displayName, displayEmail } from "@/lib/pii";



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
        select: { name: true, nickname: true, email: true, emailEnc: true }
      }
    }
  });

  // Whitelist every key rather than spreading the row. The previous version
  // spread `d` and `d.user`, which carried three raw columns past the
  // decryption: supporterEmailIdx (the blind index), user.nickname, and
  // user.emailEnc — so ciphertext and a stable per-user token both went to the
  // browser alongside the plaintext.
  const out = donations.map((d) => ({
    id: d.id,
    amount: d.amount,
    currency: d.currency,
    message: d.message,
    receivedAt: d.receivedAt,
    supporterName: dec(d.supporterName),
    supporterEmail: dec(d.supporterEmail),
    userId: d.userId,
    user: d.user
      ? {
          name: displayName(d.user) ?? null,
          email: displayEmail(d.user) ?? null,
        }
      : null,
  }));

  return NextResponse.json(out);
}
