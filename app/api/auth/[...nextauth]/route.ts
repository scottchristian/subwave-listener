import NextAuth, { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";
import { pushToAdmins } from "@/lib/push";
import { enc, dec, idx, displayName } from "@/lib/pii";


// Prisma stores no plaintext address, so every adapter entry point that
// takes or returns an email has to speak blind index. Without this wrapper
// NextAuth would look up a plaintext address, miss, and create a duplicate
// user on every sign-in.
const baseAdapter = PrismaAdapter(prisma) as any;

const adapter = {
  ...baseAdapter,
  async getUserByEmail(email: string) {
    const token = idx(email);
    return token ? baseAdapter.getUserByEmail(token) : null;
  },
  async getUserById(id: string) {
    const user = await baseAdapter.getUserById(id);
    return user ? { ...user, name: dec(user.name) } : user;
  },
  async getUserByAccount(args: any) {
    const user = await baseAdapter.getUserByAccount(args);
    return user ? { ...user, name: dec(user.name) } : user;
  },
  async createUser({ name, email, ...rest }: any) {
    return baseAdapter.createUser({
      ...rest,
      email: idx(email),
      name: enc(name),
    });
  },
  async updateUser({ name, ...rest }: any) {
    return baseAdapter.updateUser({ ...rest, name: enc(name) });
  },
};

export const authOptions: NextAuthOptions = {
  adapter,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email;
      if (!email) return false;
      const token = idx(email);
      if (!token) return false;

      const adminEmail = process.env.ADMIN_EMAIL;
      const isAdmin = !!adminEmail && email === adminEmail;

      const existingUser = await prisma.user.findUnique({ where: { email: token } });

      if (!existingUser) {
        // The adapter creates the row (with an indexed email) after we return
        // true. isApproved defaults to false, so a new signup waits for review.
      } else if (isAdmin && !existingUser.isAdmin) {
        await prisma.user.update({
          where: { email: token },
          data: { isAdmin: true, isApproved: true },
        });
      }
      return true;
    },
    async session({ session, user }) {
      // Fresh flags each session. session.user.email stays the blind index so
      // the many `where: { email: session.user.email }` lookups keep working —
      // it is opaque, so nothing here is PII. Name is decrypted for display.
      const token = (session.user as any)?.email || (user as any)?.email;
      if (token) {
        const dbUser = await prisma.user.findUnique({ where: { email: token } });
        if (dbUser) {
          const su = session.user as any;
          su.email = dbUser.email;
          su.name = dec(dbUser.name);
          su.isApproved = dbUser.isApproved;
          su.isAdmin = dbUser.isAdmin;
          su.canUseDj = dbUser.isAdmin || dbUser.canUseDj;
          su.canApprove = dbUser.isAdmin || dbUser.canApprove;
          su.canUseSkills = dbUser.isAdmin || dbUser.canUseSkills;
          su.id = dbUser.id;
        }
      }
      return session;
    },
  },
  session: {
    strategy: "database", // Standard for PrismaAdapter
  },
  pages: {
    // NextAuth's built-in error page ("try signing in with a different
    // account") reads as a verdict. Ours says what is actually wrong: most
    // sign-in failures here are the free-tier database asleep or paused, which
    // fixes itself — the page says wait and retry rather than blaming the account.
    error: "/auth-error",
  },
  secret: process.env.NEXTAUTH_SECRET,
  events: {
    // A brand-new signup (never admin — the admin email auto-approves in
    // signIn) pings every admin device so approval doesn't wait on luck.
    // The adapter already stored an indexed email and an encrypted name, so
    // decrypt for the notification text and compare tokens for the admin.
    async createUser({ user }) {
      try {
        const adminToken = idx(process.env.ADMIN_EMAIL);
        if (user.email && user.email !== adminToken) {
          const who = displayName(user as any) || "Someone";
          await pushToAdmins("New access request", `${who} wants in to ${STATION.name}`);
        }
      } catch (e) {
        console.error("Access-request push failed:", e);
      }
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
