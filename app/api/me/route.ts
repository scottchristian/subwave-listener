import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { displayEmail, dec } from "@/lib/pii";

// Fresh access state for the pending screen's approval poll. 404 means the
// account is gone (revoked-and-removed) — show "access denied", not "pending".
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  return NextResponse.json({
    // Decrypted for display only; the stored email is a blind index.
    email: displayEmail(user),
    isApproved: user.isApproved,
    isAdmin: user.isAdmin,
    canUseDj: user.isAdmin || user.canUseDj,
    canApprove: user.isAdmin || user.canApprove,
    canUseSkills: user.isAdmin || user.canUseSkills,
    // Must be decrypted. This value is bound straight into the nickname input,
    // so returning the stored value put a literal "e1:..." in the box — and
    // re-saving it wrote that ciphertext back into the nickname column.
    nickname: dec(user.nickname),
    hideLikeName: user.hideLikeName,
  });
}
