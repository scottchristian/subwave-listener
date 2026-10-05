import { PrismaClient } from "@prisma/client";
import { providerFromEnv } from "./db-provider";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;

/**
 * Which engine the live client is talking to.
 *
 * The Prisma client is generated for one provider at a time, so a cutover has
 * to regenerate it (deploy.sh does this, and the admin cutover route shells out
 * to the same step) before this reports the new value. That is deliberate: the
 * alternative — keeping two clients warm and dual-writing — is a much larger
 * correctness surface for a migration that only ever runs one at a time.
 */
export const activeProvider = () => providerFromEnv();

/**
 * Drop all pooled connections. The next query reconnects transparently — this
 * is purely about holding no sockets open. Callers: the idle paths of the
 * background loops. The free-tier database counts an open connection as
 * "in use" and will not sleep while the pool sits on it, so an idle station
 * must not just stop querying — it must hang up. Only ever called after
 * minutes of nobody here, so nothing should be mid-flight; a surprise query
 * right after simply reconnects.
 */
export async function disconnectDb(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Already down, or going down — either way the sockets are not ours now.
  }
}
