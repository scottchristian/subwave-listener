import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { fetchSkillCatalog } from "@/lib/skillcatalog";

export const dynamic = "force-dynamic";

// The skill list for the Account-menu panel. Reads Sub/Wave's catalogue with
// server-held admin credentials and returns a deliberately narrow shape — see
// lib/skillcatalog.ts.
//
// Gated on the same permission as the run route, so a user without the grant
// cannot even enumerate what exists. The menu entry is hidden from them, but
// hiding a control is not access control: this route is the real boundary.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let user;
  try {
    user = await prisma.user.findUnique({ where: { email: session.user.email } });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user || !user.isApproved) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user.isAdmin && !user.canUseSkills) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const catalog = await fetchSkillCatalog();
  if (!catalog.ok) {
    return NextResponse.json({ error: catalog.error }, { status: catalog.status });
  }
  return NextResponse.json({ skills: catalog.skills });
}