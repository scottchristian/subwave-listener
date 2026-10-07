// dbwake.ts - wake a hibernated database with exponential backoff
import { PrismaClient } from "@prisma/client";
import { providerFromEnv } from "./db-provider";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default
const KNOCK_EVERY_MS = 10 * 1000; // 10 seconds between knocks

let backgroundLoop: Promise<boolean> | null = null;

/**
 * Create a fresh Prisma client for wake attempts.
 * Using a fresh client ensures we don't use stale connection pools.
 * Uses extended connection timeout for hibernated databases.
 */
function createWakeClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  // Add extended connection timeout for hibernated databases
  const wakeUrl = url.includes("connect_timeout") ? url : `${url}&connect_timeout=180`;
  return new PrismaClient({
    datasources: { db: { url: wakeUrl } },
    log: process.env.NODE_ENV === "development" ? ["error"] : [],
  });
}

async function knock(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function wakeDb(opts?: { timeoutMs?: number; onAttempt?: (n: number) => void }): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let n = 0;
  for (;;) {
    n++;
    const client = createWakeClient();
    try {
      if (await knock(client)) return true;
    } finally {
      await client.$disconnect().catch(() => {});
    }
    opts?.onAttempt?.(n);
    if (Date.now() - started >= timeoutMs) return false;
    // Exponential backoff: start at 10s, max 60s
    const delay = Math.min(KNOCK_EVERY_MS * Math.pow(1.5, n - 1), 60_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Shared background loop: concurrent callers join the running one. */
export function wakeDbInBackground(): Promise<boolean> {
  if (!backgroundLoop) {
    console.log("[dbwake] database unreachable — knocking until it answers");
    backgroundLoop = wakeDb({
      onAttempt: (n) => {
        if (n % 6 === 1) console.log(`[dbwake] still knocking (attempt ${n})`);
      },
    }).then((ok) => {
      console.log(ok ? "[dbwake] database awake" : "[dbwake] gave up — will retry on the next visit");
      backgroundLoop = null;
      return ok;
    });
  }
  return backgroundLoop;
}

/**
 * Wake the database with a short timeout, suitable for a single request path
 * that needs the database immediately. Does not share the background loop.
 * Uses a fresh Prisma client each attempt with extended connection timeout.
 */
export async function wakeDbForRequest(timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  for (let n = 1; ; n++) {
    const client = createWakeClient();
    try {
      if (await knock(client)) return true;
    } finally {
      await client.$disconnect().catch(() => {});
    }
    if (Date.now() - started >= timeoutMs) return false;
    // Exponential backoff for request-scoped wake too
    const delay = Math.min(5_000 * Math.pow(1.5, n - 1), 30_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}