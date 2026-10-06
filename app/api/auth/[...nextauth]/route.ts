import NextAuth, { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";
import { pushToAdmins } from "@/lib/push";
import { enc, dec, idx, displayName } from "@/lib/pii";
import { dropSessionCache } from "@/lib/session-cache";


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
      // The user row is already in hand — no query needed.
      //
      // The adapter reads it with `include: { user: true }` and passes it here
      // as `user`, so every field below was already fetched. This callback used
      // to re-read that same row by email, which made two database reads per
      // authenticated request instead of one. The session cache alone could not
      // have saved it: next-auth runs this callback before any route is
      // reached, so it fires on paths the cache never sees.
      //
      // Two details carried over from that query:
      //   - session.user.email stays the blind index, so the many
      //     `where: { email: session.user.email }` lookups keep working. It is
      //     opaque, so nothing here is PII.
      //   - `user.name` arrives still ENCRYPTED, because getSessionAndUser
      //     bypasses the decrypting getUserById wrapper above. Decrypt here.
      if (!user) return session;
      // AdapterUser is next-auth's own type and does not know this schema's
      // extra columns, though the row plainly has them.
      const u = user as any;
      const su = session.user as any;
      su.email = u.email;
      su.name = dec(u.name);
      su.isApproved = u.isApproved;
      su.isAdmin = u.isAdmin;
      su.canUseDj = u.isAdmin || u.canUseDj;
      su.canApprove = u.isAdmin || u.canApprove;
      su.canUseSkills = u.isAdmin || u.canUseSkills;
      su.id = u.id;
      return session;
    },
  },
  session: {
    strategy: "database", // Standard for PrismaAdapter
  },
  pages: {
    // NextAuth's built-in pages ("try signing in with a different account")
    // read as a verdict. Ours say what is actually wrong: most sign-in
    // failures here are the free-tier database asleep or paused, which fixes
    // itself — the pages retry on their own rather than blaming the account.
    // Both doors are needed: NextAuth forces Callback-class errors onto the
    // signin page and bypasses pages.error for them (see its error-route
    // allowlist), so signin carries the same words as auth-error.
    signIn: "/signin",
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

    // Signing out must also drop the cached verdict.
    //
    // Next-auth deletes the Session row, but a cached verdict is a copy of that
    // row's meaning, and it would go on answering for a token the database no
    // longer knows. The cookie is cleared by the browser, so the row is inert in
    // practice — but "in practice" is doing the work in a security property, and
    // the fix is three lines. This is the difference between signing out taking
    // effect at once and taking effect when the revalidation interval expires.
    async signOut({ token }) {
      try {
        const raw = (token as any)?.sessionToken ?? token;
        if (typeof raw === "string" && raw) dropSessionCache(raw);
      } catch (e) {
        console.error("Sign-out cache drop failed:", e);
      }
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
