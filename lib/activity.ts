import prisma from "@/lib/prisma";

// "Is anyone here?" — the gate for all background database polling.
//
// The free-tier database must only be touched when the station needs it, so
// nothing polls on a fixed cadence around the clock. Instead every background
// loop asks this first: one indexed heartbeat lookup, answer cached briefly.
// Presence heartbeats are written by every open app (player polls /api/presence
// every 15s), so "fresh heartbeat" and "someone logged in with the app open"
// are the same thing, and a closed tab ages out on its own.
//
// SERVER-ONLY (imports prisma): never import from a client component — see
// lib/update-time.ts for the client-safe half of the world.

/** A heartbeat this fresh means its tab is still open. Matches the presence route. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** How long "nobody/everybody" is believed before re-checking. */
const CHECK_CACHE_MS = 60_000;

let cache: { at: number; active: boolean } | null = null;

export async function anyoneActive(): Promise<boolean> {
  if (cache && Date.now() - cache.at < CHECK_CACHE_MS) return cache.active;
  let active = false;
  try {
    const row = await prisma.presenceHeartbeat.findFirst({
      where: { lastSeen: { gte: new Date(Date.now() - ACTIVE_WINDOW_MS) } },
      select: { userId: true },
    });
    active = !!row;
  } catch {
    // Unreadable database, not an empty station: say nobody so callers back
    // off instead of hammering. Loops that need the database have their own
    // failure backoff and report it themselves.
    active = false;
  }
  cache = { at: Date.now(), active };
  return active;
}

/** Forget the cached answer — tests, and any caller that just changed it. */
export function resetActivityCache(): void {
  cache = null;
}
