import NextAuth, { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";
import { pushToAdmins } from "@/lib/push";



export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as any,
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
      
      const adminEmail = process.env.ADMIN_EMAIL;
      const isAdmin = email === adminEmail;
      
      const existingUser = await prisma.user.findUnique({ where: { email } });
      
      if (!existingUser) {
        // User will be created by the PrismaAdapter, but we want to intercept
        // or just let it create and we update it. Actually, PrismaAdapter creates it 
        // after signIn if we return true. But it creates with defaults.
        // We can just return true. NextAuth handles the creation.
        // The default for isApproved is false, which is what we want.
      } else if (isAdmin && !existingUser.isAdmin) {
        await prisma.user.update({
          where: { email },
          data: { isAdmin: true, isApproved: true },
        });
      }
      return true;
    },
    async session({ session, user }) {
      // Fetch fresh user data to attach flags
      if (session.user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: session.user.email },
        });
        if (dbUser) {
          (session.user as any).isApproved = dbUser.isApproved;
          (session.user as any).isAdmin = dbUser.isAdmin;
          (session.user as any).id = dbUser.id;
        }
      }
      return session;
    },
  },
  session: {
    strategy: "database", // Standard for PrismaAdapter
  },
  secret: process.env.NEXTAUTH_SECRET,
  events: {
    // A brand-new signup (never admin — the admin email auto-approves in
    // signIn) pings every admin device so approval doesn't wait on luck.
    async createUser({ user }) {
      try {
        if (user.email && user.email !== process.env.ADMIN_EMAIL) {
          await pushToAdmins(
            "New access request",
            `${user.name || user.email} wants in to ${STATION.name}`
          );
        }
      } catch (e) {
        console.error("Access-request push failed:", e);
      }
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
