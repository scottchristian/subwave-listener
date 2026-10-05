/**
 * Who is here and who is streaming — from process memory, never the database.
 *
 * Every heartbeat used to upsert a row and every presence read scanned them
 * back: several queries a minute per open tab just to say "still here". The
 * free-tier database must sleep when nobody needs it, so the live answer
 * lives here instead. Restart wipes it and the next poll round (≤30s)
 * rebuilds it; heartbeats already age out by design, so nothing depends on
 * yesterday's rows. Durable history (per-user totals, stats) keeps coming
 * from streamSession rows — this module only answers "right now".
 *
 * SERVER-ONLY (in-memory maps): never import from a client component.
 * Freshness is 2 minutes: four missed admin polls or eight missed player
 * polls drops you, with margin left over for a deploy restart.
 */

export const PRESENCE_WINDOW_MS = 2 * 60 * 1000;

/** Restarts and dead sockets orphan rows, so only young opens count. */
const STREAMING_WINDOW_MS = 10 * 60 * 1000;

/** Exactly the row fields the display helpers read — nothing more. */
export type LivePerson = {
  userId: string;
  name: string | null;
  nickname: string | null;
  email: string | null;
  emailEnc: string | null;
};

export const toLivePerson = (u: {
  id: string;
  name?: string | null;
  nickname?: string | null;
  email?: string | null;
  emailEnc?: string | null;
}): LivePerson => ({
  userId: u.id,
  name: u.name ?? null,
  nickname: u.nickname ?? null,
  email: u.email ?? null,
  emailEnc: u.emailEnc ?? null,
});

const presence = new Map<string, { lastSeen: number; person: LivePerson }>();
const streaming = new Map<string, { since: number; person: LivePerson }>();

function sweep(now: number): void {
  for (const [id, e] of presence) {
    if (now - e.lastSeen >= PRESENCE_WINDOW_MS) presence.delete(id);
  }
  for (const [id, e] of streaming) {
    if (now - e.since >= STREAMING_WINDOW_MS) streaming.delete(id);
  }
}

/** A heartbeat arrived: this user has the app open as of `now`. */
export function notePresence(person: LivePerson, now: number = Date.now()): void {
  presence.set(person.userId, { lastSeen: now, person });
  sweep(now);
}

/** A stream started. Keyed by user — one Safari Play press opens ~2 rows. */
export function noteStreamStart(person: LivePerson, now: number = Date.now()): void {
  streaming.set(person.userId, { since: now, person });
}

/** A stream ended (or its socket died — same thing to everyone else). */
export function noteStreamEnd(userId: string): void {
  streaming.delete(userId);
}

/** Fresh heartbeats, newest first. */
export function freshPresence(now: number = Date.now()): { userId: string; lastSeen: Date; person: LivePerson }[] {
  sweep(now);
  return [...presence.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((e) => ({ userId: e.person.userId, lastSeen: new Date(e.lastSeen), person: e.person }));
}

/** Streams believed live, oldest first. */
export function liveStreams(now: number = Date.now()): { userId: string; since: Date; person: LivePerson }[] {
  sweep(now);
  return [...streaming.values()]
    .sort((a, b) => a.since - b.since)
    .map((e) => ({ userId: e.person.userId, since: new Date(e.since), person: e.person }));
}
