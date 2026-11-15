import prisma from "./prisma";

// The booth conversation: what a texted request is told, and how long the
// station waits for Sub/Wave before saying the booth is busy.
//
// The timeout is an admin setting on purpose. The host resolves a request in
// under a minute normally, but TTS and a long queue can stretch it, and the
// right wait depends on the station's own hardware; an operator should not have
// to redeploy to change it.

export const BOOTH_TIMEOUT_KEY = "boothReplyTimeoutSec";
export const BOOTH_TIMEOUT_DEFAULT_SEC = 60;
export const BOOTH_TIMEOUT_MIN_SEC = 10;
export const BOOTH_TIMEOUT_MAX_SEC = 600;

/** How long a forwarded text blocks the next one from the same phone. */
export const BOOTH_HOLD_MS = 60 * 1000;

export const BOOTH_ACK = "Got your message — hang tight, someone will get back to you shortly.";
export const BOOTH_BUSY = "The booth is flat out at the moment — we'll get onto your request when we can.";
export const BOOTH_HOLD_TIGHT = "You've already got one in with the booth — hang tight.";
export const UNAUTHORISED_REPLY =
  "This number isn't authorised to text the station. Go to the app to verify your phone number first.";

/** Clamp whatever is stored; unreadable means the default, never zero. */
export function parseBoothTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(n)) return BOOTH_TIMEOUT_DEFAULT_SEC;
  return Math.min(BOOTH_TIMEOUT_MAX_SEC, Math.max(BOOTH_TIMEOUT_MIN_SEC, Math.round(n)));
}

export async function boothTimeoutSec(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: BOOTH_TIMEOUT_KEY } }).catch(() => null);
  return parseBoothTimeout(row?.value);
}

/** "4 minutes", "45 seconds" — the phrase after "You should hear it in the next". */
export function formatWaitPhrase(waitSec: number): string {
  const sec = Math.max(0, Math.round(waitSec));
  if (sec < 60) return `${sec} seconds`;
  const min = Math.max(1, Math.round(sec / 60));
  return `${min} minute${min === 1 ? "" : "s"}`;
}

/** The host's ack already says how long the wait is ("about 10 minutes away"). */
export function ackNamesWait(ack: string | null | undefined): boolean {
  return typeof ack === "string" && /\babout\s+\d+\s+(second|minute|hour)/i.test(ack);
}

/** What GET /request/:id reports for the queued track. */
export type BoothTrack = { title?: unknown; artist?: unknown } | null | undefined;

/**
 * Seconds until the queued track starts, read from the host's public queue
 * state. Null when the track is not in `upcoming` (unmeasured timing, gone, or
 * the state fetch failed) — the caller then says nothing about time rather than
 * guessing.
 */
export async function forecastWaitSec(input: {
  apiUrl: string | null;
  track: BoothTrack;
  fetchImpl?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}): Promise<number | null> {
  const title = typeof input.track?.title === "string" ? input.track.title.trim().toLowerCase() : "";
  if (!title || !input.apiUrl) return null;

  let res: Response;
  try {
    res = await (input.fetchImpl || fetch)(`${input.apiUrl}/state`, {
      signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
      cache: "no-store",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const snap: any = await res.json().catch(() => null);
  const upcoming: any[] = Array.isArray(snap?.upcoming) ? snap.upcoming : [];

  const artist =
    typeof input.track?.artist === "string" ? input.track.artist.trim().toLowerCase() : "";
  // The host allows a queue to hold the same track twice; the last match is
  // the copy just pushed.
  let idx = -1;
  for (let i = 0; i < upcoming.length; i++) {
    const item = upcoming[i];
    if (typeof item?.title !== "string" || item.title.trim().toLowerCase() !== title) continue;
    if (artist) {
      const itemArtist = typeof item.artist === "string" ? item.artist.trim().toLowerCase() : "";
      if (itemArtist !== artist) continue;
    }
    idx = i;
  }
  if (idx < 0) return null;

  const airsAt = Date.parse(upcoming[idx]?.airsAt);
  if (!Number.isFinite(airsAt)) return null;
  const sec = Math.round((airsAt - (input.now ?? Date.now())) / 1000);
  // Anything this close is "coming up"; a countdown would only be stale by the
  // time the text lands.
  return sec >= 15 ? sec : null;
}

/**
 * The one follow-up text: the booth's own ack, plus a time when neither the ack
 * nor the caller already named one. `waitSec` is computed by us from the public
 * queue state, so this never repeats "about 6 minutes… in the next 6 minutes".
 */
export function composeBoothReply(data: {
  ack?: unknown;
  track?: unknown;
  waitSec?: unknown;
}): string {
  const ack = typeof data.ack === "string" ? data.ack.trim() : "";
  const hasTrack = !!data.track && typeof data.track === "object";
  const waitSec =
    typeof data.waitSec === "number" && Number.isFinite(data.waitSec) ? data.waitSec : null;
  const eta =
    waitSec !== null && hasTrack && !ackNamesWait(ack)
      ? `You should hear it in the next ${formatWaitPhrase(waitSec)}.`
      : "";
  if (ack && eta) return `${ack} ${eta}`;
  if (ack) return ack;
  if (eta) return eta;
  if (hasTrack) return "Your request is in the booth's queue.";
  return "The DJ has your message.";
}
