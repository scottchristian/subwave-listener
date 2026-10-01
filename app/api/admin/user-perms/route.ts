import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Per-user booth permissions, set individually: Manual Voice DJ, approve
// access, or promote to full admin. Admin implies the other two, so promoting
// switches them on and the UI greys them out; demoting leaves the grants as
// they were. Admin-only — these are the controls that grant the others.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { userId?: unknown; isAdmin?: unknown; canUseDj?: unknown; canApprove?: unknown; canUseSkills?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (userId === (session?.user as any)?.id && body.isAdmin === false) {
    return NextResponse.json({ error: "You cannot demote yourself" }, { status: 400 });
  }

  const data: { isAdmin?: boolean; canUseDj?: boolean; canApprove?: boolean; canUseSkills?: boolean } = {};
  if (typeof body.isAdmin === "boolean") {
    data.isAdmin = body.isAdmin;
    // Admin carries the other three — keep the stored flags consistent so the
    // greyed toggles show the truth rather than a stale "off".
    if (body.isAdmin) {
      data.canUseDj = true;
      data.canApprove = true;
      data.canUseSkills = true;
    }
  }
  if (typeof body.canUseDj === "boolean") data.canUseDj = body.canUseDj;
  if (typeof body.canApprove === "boolean") data.canApprove = body.canApprove;
  if (typeof body.canUseSkills === "boolean") data.canUseSkills = body.canUseSkills;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  const updated = await prisma.user.update({ where: { id: userId }, data });
  return NextResponse.json({
    success: true,
    user: {
      id: updated.id,
      isAdmin: updated.isAdmin,
      canUseDj: updated.isAdmin || updated.canUseDj,
      canApprove: updated.isAdmin || updated.canApprove,
      canUseSkills: updated.isAdmin || updated.canUseSkills,
    },
  });
}
