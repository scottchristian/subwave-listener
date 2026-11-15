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

/**
 * The one follow-up text: the booth's own ack, plus a time when the ack did not
 * already name one. The host reports `waitNoticeSec` as the amount it embedded,
 * so this never repeats "about 6 minutes… in the next 6 minutes".
 */
export function composeBoothReply(data: {
  ack?: unknown;
  track?: unknown;
  waitSec?: unknown;
  waitNoticeSec?: unknown;
}): string {
  const ack = typeof data.ack === "string" ? data.ack.trim() : "";
  const hasTrack = !!data.track && typeof data.track === "object";
  const waitSec =
    typeof data.waitSec === "number" && Number.isFinite(data.waitSec) ? data.waitSec : null;
  const noticed =
    typeof data.waitNoticeSec === "number" && Number.isFinite(data.waitNoticeSec)
      ? data.waitNoticeSec
      : null;
  const eta =
    waitSec !== null && noticed === null && hasTrack
      ? `You should hear it in the next ${formatWaitPhrase(waitSec)}.`
      : "";
  if (ack && eta) return `${ack} ${eta}`;
  if (ack) return ack;
  if (eta) return eta;
  if (hasTrack) return "Your request is in the booth's queue.";
  return "The DJ has your message.";
}
