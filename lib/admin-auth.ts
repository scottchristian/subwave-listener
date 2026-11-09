import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

/**
 * Admin-only, for every operator-facing route.
 *
 * The session says the account was an admin when it signed in. That is not the
 * same as saying it is one now: a demoted or deleted account can still hold a
 * cookie. Re-reading the User row means demotion takes effect on the next
 * request rather than at the next sign-in.
 *
 * Returns null when the caller is not an admin; callers answer 403. The id is
 * null when the session has no usable User row but is still flagged admin — the
 * existing audit columns accept null, and refusing outright would break the
 * operator who was provisioned before ids were stored in the session.
 */
export async function requireAdmin(): Promise<{ id: string | null } | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!user?.isAdmin) return null;
  // The row's isAdmin is the verdict that counts, not the copy burned into the
  // cookie at sign-in. Returning null on a demoted row is what makes "demotion
  // takes effect on the next request" true; looking the row up only for its id
  // left a demoted admin with fleet-wide authority.
  if (typeof user.id === "string" && user.id) {
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, isAdmin: true } });
    if (row) return row.isAdmin ? { id: row.id } : null;
  }
  if (typeof user.email === "string" && user.email) {
    const row = await prisma.user.findUnique({ where: { email: user.email }, select: { id: true, isAdmin: true } });
    if (row) return row.isAdmin ? { id: row.id } : null;
  }
  return { id: null };
}
