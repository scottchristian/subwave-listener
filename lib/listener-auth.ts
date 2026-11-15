// Listener-session helper for the phone routes.
//
// The session copy of isApproved is what the sign-in check left in the cookie;
// approval can be revoked after that, so the phone line refuses unapproved
// accounts rather than trusting the stale flag alone on the link path.

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

export async function requireUser(): Promise<{ id: string } | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as any;
  if (!user?.id || !user.isApproved) return null;
  return { id: String(user.id) };
}
