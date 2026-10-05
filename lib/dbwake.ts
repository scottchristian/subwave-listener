import prisma from "@/lib/prisma";

/**
 * Knock until the database answers. A hibernated database wakes on traffic,
 * but waking takes seconds to minutes — longer than any single query is
 * willing to wait — so one attempt is never enough. This loops a cheap
 * SELECT until it lands or time runs out, and reports which happened.
 *
 * Fire-and-forget via wakeDbInBackground() from request paths: many
 * simultaneous visitors must share one loop, not start one each.
 */

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
