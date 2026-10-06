import prisma from "@/lib/prisma";

/**
 * Reap StreamSession rows that were opened but never closed.
 *
 * Why they exist: the stream route closes a row when the proxy connection is
 * torn down. That teardown does not always happen — a killed tab, a dropped
 * network, a redeploy mid-stream — and the row is left with no endTime and no
 * durationSec forever. It is not a display bug: the stats route already ignores
 * an open row older than an hour, so these contribute neither time nor a
 * session count.
 *
 * It is a growth problem. This table only ever grows, and Admin → Stats reads
 * the entire history on every open (app/api/admin/stats/route.ts). One account
 * alone reached 4,949 orphans against a few hundred real sessions.
 *
 * Deleting rather than closing them: a row with no endTime and no durationSec
 * is already treated as worthless by every reader, and a synthetic endTime
 * would put invented data into the history. What is left behind is only the
 * evidence that it was once open, which nothing reports.
 */

/**
 * How old an unclosed row must be before it is reaped.
 *
 * A day, deliberately more conservative than the hour the stats route uses. The
 * stats route merely *ignores* a young orphan; this *removes* it, and an hour
 * is short enough that a genuine multi-hour listen on a flaky connection could
 * still be swept up. A day removes the entire historical backlog while leaving
 * a comfortable margin, and orphans only accumulate when something has already
 * gone wrong.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** How often to look. Twice a day is well inside the free tier's sleep window. */
export const PRUNE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type PruneResult = {
  /** Orphans found, whether or not this was a dry run. */
  matched: number;
  /** Orphans actually removed. Zero on a dry run. */
  removed: number;
  /** Cutoff applied, for the log line. */
  cutoff: Date;
  ok: boolean;
};

/** Milliseconds to wait after boot before the first sweep. */
const BOOT_DELAY_MS = 60_000;

/**
 * Delete unclosed rows older than `minAgeMs`.
 *
 * `now` is injectable so the age boundary can be tested without waiting a day.
 * Failures are reported, never thrown: a housekeeping job that cannot run must
 * not take the station with it.
 */
export async function pruneOrphanStreamSessions(
  opts: { now?: number; minAgeMs?: number; dryRun?: boolean } = {}
): Promise<PruneResult> {
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - (opts.minAgeMs ?? ORPHAN_MIN_AGE_MS));
  try {
    // endTime IS NULL AND startTime < cutoff is served by the [endTime, startTime]
    // index, so this stays cheap as the table grows.
    const where = { endTime: null, startTime: { lt: cutoff } } as const;
    if (opts.dryRun) {
      const matched = await prisma.streamSession.count({ where });
      return { matched, removed: 0, cutoff, ok: true };
    }
    const { count } = await prisma.streamSession.deleteMany({ where });
    return { matched: count, removed: count, cutoff, ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e).trim().split("\n")[0].slice(0, 160);
    console.warn(`[session-prune] skipped: ${msg}`);
    return { matched: 0, removed: 0, cutoff, ok: false };
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastPrunedAt = 0;

/**
 * Run the sweep shortly after boot, then twice a day.
 *
 * Deliberately not run at boot: the database may still be starting, and the
 * first sweep after a redeploy is also the one most likely to be competing with
 * a warm-up query. Idempotent, so calling it twice is harmless.
 */
export function startSessionPruneScheduler(): void {
  if (timer) return;
  const loop = async () => {
    try {
      if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
        lastPrunedAt = Date.now();
        const res = await pruneOrphanStreamSessions();
        if (res.ok && res.removed > 0) {
          console.log(`[session-prune] removed ${res.removed} unclosed session row(s) older than ${res.cutoff.toISOString()}`);
        }
      }
    } catch (e) {
      console.warn("[session-prune] sweep failed:", e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150));
    } finally {
      timer = setTimeout(loop, PRUNE_INTERVAL_MS);
      (timer as any).unref?.();
    }
  };
  timer = setTimeout(loop, BOOT_DELAY_MS);
  (timer as any).unref?.();
}

/** Test seam. */
export function resetPruneScheduler(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  lastPrunedAt = 0;
}
