/**
 * "Is anyone here?" — the gate for all background database polling.
 *
 * The free-tier database sleeps after 15 minutes without a query and must
 * average ~6 idle hours a day, so background loops cannot ask the database
 * whether anyone is here — the question itself would keep it awake. Instead
 * every presence heartbeat also stamps process memory (single pm2 process, so
 * memory is the whole world), and the loops read the stamp for free.
 *
 * Presence heartbeats arrive from every open app every ~15s and stop when
 * tabs close, so "fresh stamp" and "someone logged in with the app open" are
 * the same thing. A fresh boot knows nobody (stamp zero) until the first
 * heartbeat lands; boot-time reconciliation already handled stranded rows.
 *
 * Pure functions of time, so tests drive the clock by hand. No prisma import —
 * importing it here would make the gate cost what it saves.
 */

/** A stamp this fresh means its tab is still open. Matches the presence route (2 min). */
export const ACTIVE_WINDOW_MS = 2 * 60 * 1000;

let lastSeenAt = 0;

/** Stamp now (or the given time). Called on every presence heartbeat. */
export function noteActivity(at: number = Date.now()): void {
  lastSeenAt = at;
}

/** Anyone with the app open as of `now`? Never touches the database. */
export function anyoneActive(now: number = Date.now()): boolean {
  return now - lastSeenAt < ACTIVE_WINDOW_MS;
}
