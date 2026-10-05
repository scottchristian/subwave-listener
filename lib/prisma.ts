import { PrismaClient } from "@prisma/client";
import { providerFromEnv } from "./db-provider";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Self-hangup: drop this client's pool after 15 quiet minutes.
 *
 * One PrismaClient per module graph means nobody else can hang up this
 * pool for us — the background loops disconnect their own instance while
 * request serving holds its sockets open forever. So every instance watches
 * itself: a $use stamp on each query, and a 5-minute interval that
 * disconnects after 15 query-free minutes (the free plan's sleep window).
 * Unref'd so builds and tests never hang on it; keyed on the client so HMR
 * duplicates each manage themselves.
 */
const IDLE_HANGUP_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
type Sweepable = { __lastQueryAt?: number; __sweeperStarted?: boolean };
const sweepable = prisma as unknown as Sweepable;
// Note: $use does not see $queryRaw — only the keepalive ping uses raw, and
// it is off unless the operator arms it (in which case sleeping is not the
// goal anyway).
prisma.$use(async (params, next) => {
  sweepable.__lastQueryAt = Date.now();
  return next(params);
});
if (!sweepable.__sweeperStarted) {
  sweepable.__sweeperStarted = true;
  const sweep = setInterval(() => {
    if (Date.now() - (sweepable.__lastQueryAt || 0) > IDLE_HANGUP_MS) {
      prisma.$disconnect().catch(() => {});
    }
  }, SWEEP_MS);
  (sweep as unknown as { unref?: () => void }).unref?.();
}

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
