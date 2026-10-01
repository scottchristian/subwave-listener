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
