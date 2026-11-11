import { PrismaClient } from "@prisma/client";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
type Sweepable = {
  __lastQueryAt?: number;
  __sweeperStarted?: boolean;
  __queryCounts?: Record<string, { count: number; lastAt: number }>;
};
const sweepable = prisma as unknown as Sweepable;
// Note: $use does not see $queryRaw — only the keepalive ping uses raw, and
// it is off unless the operator arms it (in which case sleeping is not the
// goal anyway).
prisma.$use(async (params, next) => {
  sweepable.__lastQueryAt = Date.now();
  // Per-table tally for the activity endpoint: when the dashboard says
  // Running but nobody is here, this names the exact query that did it.
  // Counts only — no args, no rows, nothing personal.
  const key = `${(params as any).model || "raw"}.${(params as any).action || "query"}`;
  const tally = (sweepable.__queryCounts ??= {});
  const slot = (tally[key] ??= { count: 0, lastAt: 0 });
  slot.count++;
  slot.lastAt = Date.now();
  // ...and one line in the shared audit file, because module graphs differ
  // per runtime (proxy, routes, instrumentation each hold their own client)
  // while the filesystem is the same for all of them. Local append only —
  // never the database. Trimmed on read, not on write.
  try {
    appendFileSync(auditPath(), `${Date.now()} ${key}\n`);
  } catch {
    // Observability must never break the query it observes.
  }
  return next(params);
});

/** Shared query audit all runtimes append to. Local disk, never the database. */
export function auditPath(): string {
  return path.join(process.cwd(), "data", "query-audit.log");
}

const AUDIT_KEEP_LINES = 300;

/** Most recent queries across every runtime, newest last. Trims the file. */
export function readQueryAudit(): { at: string; query: string }[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(auditPath(), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  if (lines.length > AUDIT_KEEP_LINES * 2) {
    try {
      writeFileSync(auditPath(), lines.slice(-AUDIT_KEEP_LINES).join("\n") + "\n");
    } catch {}
    lines = lines.slice(-AUDIT_KEEP_LINES);
  }
  return lines.slice(-AUDIT_KEEP_LINES).map((l) => {
    const sp = l.indexOf(" ");
    return {
      at: new Date(Number(l.slice(0, sp))).toISOString(),
      query: l.slice(sp + 1),
    };
  });
}

/**
 * What has this process asked the database, since boot. Served to admins at
 * /api/admin/database/activity — the answer to "who is keeping it awake".
 */
export function dbQueryStats(): {
  tables: Record<string, { count: number; lastAt: string | null }>;
  totalQueries: number;
  lastQueryAt: string | null;
} {
  const tally = sweepable.__queryCounts ?? {};
  const tables: Record<string, { count: number; lastAt: string | null }> = {};
  let totalQueries = 0;
  let last = 0;
  for (const [k, v] of Object.entries(tally)) {
    tables[k] = { count: v.count, lastAt: v.lastAt ? new Date(v.lastAt).toISOString() : null };
    totalQueries += v.count;
    if (v.lastAt > last) last = v.lastAt;
  }
  return { tables, totalQueries, lastQueryAt: last ? new Date(last).toISOString() : null };
}
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
