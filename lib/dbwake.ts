// dbwake.ts - wake a hibernated database with exponential backoff
import prisma from "@/lib/prisma";

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const KNOCK_EVERY_MS = 5 * 1000;

let backgroundLoop: Promise<boolean> | null = null;

async function knock(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
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
    if (await knock()) return true;
    opts?.onAttempt?.(n);
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, KNOCK_EVERY_MS));
  }
}

/** Shared background loop: concurrent callers join the running one. */
export function wakeDbInBackground(): Promise<boolean> {
  if (!backgroundLoop) {
    console.log("[dbwake] database unreachable — knocking until it answers");
    backgroundLoop = wakeDb({
      onAttempt: (n) => {
        if (n % 12 === 1) console.log(`[dbwake] still knocking (attempt ${n})`);
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
 */
export async function wakeDbForRequest(timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  for (let n = 1; ; n++) {
    if (await knock()) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, Math.min(KNOCK_EVERY_MS, timeoutMs / 10)));
  }
}