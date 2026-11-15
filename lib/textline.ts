// textline.ts — the listener text line: link a phone by code, text requests in,
// one reminder per opted-in show, and STOP honoured everywhere.
//
// Ownership rules that the rest of the app relies on:
//   - A phone belongs to exactly one account (unique userId and unique phone).
//   - Only a verified contact can hold show bells or receive reminders.
//   - Opt-out is sticky everywhere until the listener re-enables a bell in the
//     app: opted-out contacts are filtered out of every send, not just reminders.
//   - Unlinking deletes the contact row, and the database cascades the
//     transcript, bells and reminder claims with it. Nothing is archived.
//
// The Linq send is injected (opts.send) so the checks can drive the whole
// state machine against a fake without any network.

import crypto from "node:crypto";
import prisma from "./prisma";
import { STATION } from "./station";
import { isOptOut, normalizePhone } from "./phone";
import { readLinqConfig, sendText, type SendResult } from "./linq";
import { listenerCount } from "./update-run";
import { fetchStationSchedule, type ScheduleShow, type StationSchedule } from "./station-schedule";

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const REMINDER_LEAD_MIN = 15;
/**
 * How long an entered number stays armed for its first text. Nothing is sent
 * when the number is entered; the bind code goes out when a text from that
 * number arrives. Long enough to switch apps and send, short enough that a
 * number typed once is not still armed tomorrow.
 */
export const AWAIT_TEXT_MS = 30 * 60 * 1000;
/**
 * The shortest gap between two code sends for one phone. The panel hides its
 * resend button for this long and the server refuses earlier, so an impatient
 * tap cannot bill the station for a burst of texts.
 */
export const RESEND_WAIT_MS = 10 * 1000;
/** Inbound records are pruned here; they answer "did the text reach us?". */
const INBOUND_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * When the station reports nobody listening, a text gets one reply saying so.
 * One an hour per contact: a burst of texts while the room is empty is still
 * one SMS bill, not five.
 */
export const OFFLINE_REPLY = `The station isn't online at the moment. Come back later and send your message again.`;
export const OFFLINE_REPLY_MS = 60 * 60 * 1000;

export type Send = (to: string, body: string, opts?: { overrideOptout?: boolean; idempotencyKey?: string }) => Promise<SendResult>;

export type LinkResult = { ok: true } | { ok: false; code: string; message: string };

const fail = (code: string, message: string): LinkResult => ({ ok: false, code, message });

function hashCode(code: string): string {
  const secret = process.env.NEXTAUTH_SECRET || "textline-dev";
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

function sixDigits(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The station's public address, for links in texts. Trailing slash stripped. */
export function publicBaseUrl(): string {
  return String(process.env.NEXTAUTH_URL || "").trim().replace(/\/+$/, "");
}

/**
 * One reminder bubble. The link is the point of the text — it opens the
 * station in a tap — and the STOP footer is the promise made when the bell
 * was switched on.
 */
export function reminderBody(showName: string, minutes: number, stationName: string, url: string): string {
  const listen = url ? ` Listen: ${url} —` : "";
  return `${showName} starts in ${minutes} min on ${stationName}.${listen} Reply STOP to stop show alerts.`;
}

/**
 * Step one: remember the number, and send nothing. The bind code goes out in
 * handleInbound when a text from this number arrives — the number has to be
 * on file first so the text can be matched to the account it belongs to, and
 * on the free Shared Line the inbound is the whole trigger.
 */
export async function beginLink(
  userId: string,
  rawPhone: string,
  opts: { defaultCountry: string; now?: number }
): Promise<LinkResult> {
  const phone = normalizePhone(rawPhone, opts.defaultCountry);
  if (!phone) return fail("invalid_phone", "That doesn't look like a phone number. Try 0408 344 123 or +61 408 344 123.");

  const mine = await prisma.phoneContact.findUnique({ where: { userId }, select: { phone: true } });
  if (mine) return fail("already_linked", "Your phone is already linked.");

  const other = await prisma.phoneContact.findUnique({ where: { phone }, select: { userId: true } });
  if (other) return fail("phone_taken", "That number is already linked to another account.");

  const now = opts.now ?? Date.now();

  // One waiting link per number: two accounts armed for the same phone would
  // each text a different code in answer to the same inbound text.
  const elsewhere = await prisma.phoneVerification.findFirst({
    where: { phone, userId: { not: userId }, expiresAt: { gt: new Date(now) } },
    select: { userId: true },
  });
  if (elsewhere) {
    return fail("phone_taken", "Someone is already linking that number. If it's yours, try again in a few minutes.");
  }

  const pending = await prisma.phoneVerification.findUnique({
    where: { userId },
    select: { phone: true, codeHash: true, expiresAt: true },
  });
  // Re-entering the same number while its code is still valid keeps that code:
  // the listener is on the code step, not starting over.
  if (pending && pending.phone === phone && pending.codeHash && pending.expiresAt.getTime() > now) {
    return { ok: true };
  }

  await prisma.phoneVerification.upsert({
    where: { userId },
    create: { userId, phone, codeHash: "", expiresAt: new Date(now + AWAIT_TEXT_MS) },
    update: { phone, codeHash: "", attempts: 0, createdAt: new Date(now), expiresAt: new Date(now + AWAIT_TEXT_MS) },
  });
  return { ok: true };
}

/**
 * Send the live bind code again. Only valid once a code has gone out: that
 * send is what opened the chat, so from then on the line can reply without
 * waiting for another text. A failed resend restores the previous code, which
 * may still be on its way or already on the phone.
 */
export async function resendLinkCode(userId: string, opts: { send?: Send; now?: number } = {}): Promise<LinkResult> {
  const now = opts.now ?? Date.now();
  const pending = await prisma.phoneVerification.findUnique({ where: { userId } });
  if (!pending) return fail("no_code", "There's no code waiting. Enter your number and text us to get one.");
  if (pending.expiresAt.getTime() < now) {
    await prisma.phoneVerification.deleteMany({ where: { userId } });
    return fail("expired", "That code has expired. Enter your number again and text us for a new one.");
  }
  if (!pending.codeHash) {
    return fail("awaiting_text", "We haven't texted you yet. Send the station a text from that number and the code comes back.");
  }
  if (now - pending.createdAt.getTime() < RESEND_WAIT_MS) {
    return fail("too_soon", "Give it a few seconds, then try again.");
  }

  const code = sixDigits();
  const claim = await prisma.phoneVerification.updateMany({
    where: { userId, codeHash: pending.codeHash },
    data: { codeHash: hashCode(code), attempts: 0, createdAt: new Date(now), expiresAt: new Date(now + LINK_CODE_TTL_MS) },
  });
  if (claim.count !== 1) return fail("no_code", "There's no code waiting. Enter your number and text us to get one.");

  const res = await (opts.send || sendText)(pending.phone, `${code} is your ${STATION.name} bind code. It expires in 10 minutes.`);
  if (!res.ok) {
    await prisma.phoneVerification
      .updateMany({
        where: { userId, codeHash: hashCode(code) },
        data: { codeHash: pending.codeHash, expiresAt: pending.expiresAt },
      })
      .catch(() => {});
    console.warn("[textline] bind code resend failed:", res.error, res.traceId ? `trace ${res.traceId}` : "");
    return fail("send_failed", "The station couldn't send a new code. Try again in a moment.");
  }
  return { ok: true };
}

/**
 * Step two: prove the phone. Attempts are capped and the code expires; both
 * delete the pending row so the only way forward is a fresh code. On success
 * the contact exists and the welcome text is sent (best effort — the phone is
 * proven either way).
 */
export async function verifyLink(
  userId: string,
  rawCode: string,
  opts: { send?: Send; now?: number } = {}
): Promise<LinkResult> {
  const code = String(rawCode || "").trim();
  if (!/^\d{6}$/.test(code)) return fail("invalid_code", "Enter the six digits from the message.");

  const pending = await prisma.phoneVerification.findUnique({ where: { userId } });
  if (!pending) return fail("no_code", "There's no code waiting. Enter your number and text us to get one.");

  const now = opts.now ?? Date.now();
  if (pending.expiresAt.getTime() < now) {
    await prisma.phoneVerification.deleteMany({ where: { userId } });
    return fail("expired", "That code has expired. Enter your number again and text us for a new one.");
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    await prisma.phoneVerification.deleteMany({ where: { userId } });
    return fail("too_many", "Too many tries. Enter your number again and text us for a new one.");
  }

  const expected = Buffer.from(pending.codeHash, "hex");
  const got = Buffer.from(hashCode(code), "hex");
  const matches = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  if (!matches) {
    await prisma.phoneVerification.update({ where: { userId }, data: { attempts: { increment: 1 } } });
    return fail("invalid_code", "That code doesn't match. Check the message and try again.");
  }

  const contact = await prisma.$transaction(async (tx) => {
    await tx.phoneVerification.deleteMany({ where: { userId } });
    return tx.phoneContact.upsert({
      where: { userId },
      create: { userId, phone: pending.phone, verifiedAt: new Date(now) },
      update: { phone: pending.phone, verifiedAt: new Date(now), optedOutAt: null },
    });
  });

  const welcome = `You're linked to ${STATION.name}. Text a request or shout-out any time — and you can turn on show reminders in the app's Shows screen.`;
  const send = opts.send || sendText;
  const res = await send(contact.phone, welcome);
  if (res.ok) {
    await prisma.textMessage
      .create({ data: { contactId: contact.id, direction: "out", body: welcome, providerId: res.id || null } })
      .catch(() => {});
  } else {
    console.warn("[textline] welcome text failed:", res.error);
  }
  return { ok: true };
}

/** Erasure: the contact and everything hanging off it, in one transaction. */
export async function unlinkPhone(userId: string): Promise<{ ok: true }> {
  await prisma.$transaction([
    prisma.phoneVerification.deleteMany({ where: { userId } }),
    prisma.phoneContact.deleteMany({ where: { userId } }),
  ]);
  return { ok: true };
}

export type PhoneStatus = {
  available: boolean;
  linked: boolean;
  phone: string | null;
  optedOut: boolean;
  showIds: string[];
  codeSentAt: string | null;
  /** Where the pending code went; the panel names it when a code step is resumed. */
  pendingPhone: string | null;
  /** The number is on file and the panel is waiting for its text. */
  awaitingText: boolean;
  messages: { id: string; direction: string; body: string; createdAt: string }[];
};

/** Everything the Account panel needs in one read. */
export async function phoneStatus(userId: string): Promise<PhoneStatus> {
  const [contact, pending] = await Promise.all([
    prisma.phoneContact.findUnique({
      where: { userId },
      include: {
        showAlerts: { select: { showId: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 100 },
      },
    }),
    prisma.phoneVerification.findUnique({
      where: { userId },
      select: { createdAt: true, phone: true, codeHash: true, expiresAt: true },
    }),
  ]);
  // An expired pending row is no pending row: the panel goes back to step one
  // instead of showing a code box for a code that can no longer be used.
  const live = pending && pending.expiresAt.getTime() > Date.now() ? pending : null;
  return {
    available: readLinqConfig().enabled,
    linked: !!contact?.verifiedAt,
    phone: contact?.phone ?? null,
    optedOut: !!contact?.optedOutAt,
    showIds: contact?.showAlerts.map((a) => a.showId) ?? [],
    codeSentAt: live?.codeHash ? live.createdAt.toISOString() : null,
    pendingPhone: live?.phone ?? null,
    awaitingText: !!live && !live.codeHash,
    messages: (contact?.messages ?? [])
      .slice()
      .reverse()
      .map((m) => ({ id: m.id, direction: m.direction, body: m.body, createdAt: m.createdAt.toISOString() })),
  };
}

/**
 * A bell. Turning one on is also the documented way back from STOP, so it
 * clears the opt-out — nothing else does.
 */
export async function setShowAlert(
  userId: string,
  showId: string,
  enabled: boolean
): Promise<{ ok: boolean; code?: string }> {
  const contact = await prisma.phoneContact.findUnique({ where: { userId }, select: { id: true, verifiedAt: true } });
  if (!contact?.verifiedAt) return { ok: false, code: "not_linked" };
  if (enabled) {
    await prisma.$transaction([
      prisma.showAlert.upsert({
        where: { contactId_showId: { contactId: contact.id, showId } },
        create: { contactId: contact.id, showId },
        update: {},
      }),
      prisma.phoneContact.update({ where: { id: contact.id }, data: { optedOutAt: null } }),
    ]);
  } else {
    await prisma.showAlert.deleteMany({ where: { contactId: contact.id, showId } });
  }
  return { ok: true };
}

export type InboundEvent = {
  phone: string;
  body: string;
  providerId?: string | null;
  isGroup?: boolean;
  /** The chat's health_status from the webhook; OPTED_OUT is the carrier's own STOP. */
  chatHealth?: string | null;
};

/**
 * An inbound text. A number entered in the app but not yet linked gets its
 * bind code back; any other unknown number is ignored. STOP from a linked
 * number records the opt-out, clears every bell, and sends one confirmation.
 */
export async function handleInbound(
  evt: InboundEvent,
  opts: { send?: Send; now?: number; listeners?: () => Promise<number | null> } = {}
): Promise<{ handled: boolean }> {
  if (evt.isGroup) return { handled: false };
  const phone = normalizePhone(evt.phone);
  const body = String(evt.body || "").trim();
  if (!phone || !body) return { handled: false };

  const now = new Date(opts.now ?? Date.now());

  // Proof that a text reached the line, one row per delivery — this is what
  // answers "did their text ever arrive?". providerId is unique, so an
  // at-least-once redelivery adds nothing; old rows are pruned here because
  // this is their only writer.
  await prisma.textlineInbound
    .deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - INBOUND_KEEP_MS) } } })
    .catch(() => {});
  await prisma.textlineInbound
    .create({ data: { phone, providerId: evt.providerId ?? null } })
    .catch(() => null);

  const contact = await prisma.phoneContact.findUnique({ where: { phone }, select: { id: true, optedOutAt: true } });
  if (!contact) {
    // A number entered in the app is waiting for its bind code, and this text
    // is what releases it: the station cannot open the conversation itself.
    // Claim the row before sending so two deliveries of one text cannot text
    // two different codes.
    const waiting = isOptOut(body)
      ? null
      : await prisma.phoneVerification.findFirst({
          where: { phone, codeHash: "", expiresAt: { gt: now } },
          select: { userId: true },
        });
    if (!waiting) return { handled: false };

    const code = sixDigits();
    const claim = await prisma.phoneVerification.updateMany({
      where: { userId: waiting.userId, codeHash: "", expiresAt: { gt: now } },
      data: { codeHash: hashCode(code), attempts: 0, createdAt: now, expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS) },
    });
    if (claim.count !== 1) return { handled: true };

    const res = await (opts.send || sendText)(phone, `${code} is your ${STATION.name} bind code. It expires in 10 minutes.`);
    if (!res.ok) {
      // No code reached the phone, so the link stays armed for the next text.
      // The listener only knows that nothing came back.
      await prisma.phoneVerification
        .updateMany({
          where: { userId: waiting.userId, codeHash: hashCode(code) },
          data: { codeHash: "", expiresAt: new Date(now.getTime() + AWAIT_TEXT_MS) },
        })
        .catch(() => {});
      console.warn("[textline] bind code send failed:", res.error, res.traceId ? `trace ${res.traceId}` : "");
    }
    return { handled: true };
  }

  if (evt.providerId) {
    const seen = await prisma.textMessage.findUnique({ where: { providerId: evt.providerId }, select: { id: true } });
    if (seen) return { handled: true };
  }

  // Timestamps come from `now`, not the database clock, so the offline-reply
  // throttle below agrees with the same clock the caller reasons about.
  const log = (direction: string, text: string, providerId: string | null = null) =>
    prisma.textMessage.create({ data: { contactId: contact.id, direction, body: text, providerId, createdAt: now } }).catch(() => null);

  // A keyword STOP and Linq marking the chat OPTED_OUT are the same promise.
  // Only the keyword gets our single courtesy reply: Linq records an override
  // per use, so a carrier-only opt-out must not add a second text.
  const keywordOptOut = isOptOut(body);
  const carrierOptOut = String(evt.chatHealth || "").toUpperCase() === "OPTED_OUT";
  if (keywordOptOut || carrierOptOut) {
    const first = !contact.optedOutAt;
    if (first) {
      await prisma.$transaction([
        prisma.phoneContact.update({ where: { id: contact.id }, data: { optedOutAt: now } }),
        prisma.showAlert.deleteMany({ where: { contactId: contact.id } }),
      ]);
    }
    await log("in", body, evt.providerId ?? null);
    if (first && keywordOptOut) {
      const reply = `You're unsubscribed from ${STATION.name} show alerts. Turn them back on any time in the app's Shows screen.`;
      const res = await (opts.send || sendText)(phone, reply, { overrideOptout: true });
      if (res.ok) await log("out", reply, res.id || null);
      else console.warn("[textline] opt-out confirmation failed:", res.error);
    }
    return { handled: true };
  }

  await log("in", body, evt.providerId ?? null);

  // Nobody on air: the request would go unheard, so say so. Only a known zero
  // triggers this — an unreadable count must not tell anyone the station is
  // down. Opted-out contacts get nothing, exactly like every other send.
  if (!contact.optedOutAt) {
    const listeners = await (opts.listeners || (() => listenerCount(5000)))();
    if (listeners === 0) {
      const recent = await prisma.textMessage.findFirst({
        where: {
          contactId: contact.id,
          direction: "out",
          body: OFFLINE_REPLY,
          createdAt: { gte: new Date(now.getTime() - OFFLINE_REPLY_MS) },
        },
        select: { id: true },
      });
      if (!recent) {
        const res = await (opts.send || sendText)(phone, OFFLINE_REPLY);
        if (res.ok) await log("out", OFFLINE_REPLY, res.id || null);
        else console.warn("[textline] offline reply failed:", res.error);
      }
    }
  }
  return { handled: true };
}

// ------------------------------------------------------------- reminders

const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad2 = (n: number) => String(n).padStart(2, "0");

type StationClock = { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };

function stationClock(timezone: string, nowMs: number): StationClock | null {
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs))) {
      parts[p.type] = p.value;
    }
    const weekday = DAY_KEYS.indexOf(parts.weekday);
    const year = parseInt(parts.year, 10);
    const month = parseInt(parts.month, 10);
    const day = parseInt(parts.day, 10);
    const hour = parseInt(parts.hour, 10) % 24;
    const minute = parseInt(parts.minute, 10) % 60;
    const second = parseInt(parts.second, 10) % 60;
    if (weekday < 0 || ![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    return { year, month, day, weekday, hour, minute, second };
  } catch {
    return null;
  }
}

function localDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export type UpcomingStart = {
  showId: string;
  name: string;
  slotKey: string;
  minutes: number;
  startsAtMs: number;
};

/**
 * Shows whose slot begins within `leadMinutes` of `nowMs`, in station time.
 * A start is a slot whose show differs from the hour before it — the same
 * "consecutive hours merge" rule the Shows panel paints. Pure and exported so
 * every boundary (midnight, day rollover, exact hour) is testable.
 */
export function upcomingStarts(
  grid: Record<string, unknown>,
  shows: ScheduleShow[],
  timezone: string,
  nowMs: number,
  leadMinutes: number
): UpcomingStart[] {
  const clock = stationClock(timezone, nowMs);
  if (!clock) return [];
  const names = new Map(shows.map((s) => [s.id, s.name || s.id]));
  const rowAt = (dayOffset: number, hour: number): string | null => {
    const row = grid[String((((clock.weekday + dayOffset) % 7) + 7) % 7)];
    if (!Array.isArray(row)) return null;
    return ((row as (string | null)[])[((hour % 24) + 24) % 24] ?? null) as string | null;
  };

  const nowMin = clock.hour * 60 + clock.minute;
  const out: UpcomingStart[] = [];
  for (let offset = 0; offset <= Math.ceil(leadMinutes / 60); offset++) {
    const absMin = clock.hour * 60 + offset * 60;
    const delta = absMin - nowMin;
    // delta 0 is "starting now", not "starts in N min" — a tick that lands
    // exactly on the hour must not announce a show that has already begun.
    if (delta <= 0 || delta > leadMinutes) continue;
    const dayOffset = Math.floor(absMin / 1440);
    const hour = (absMin % 1440) / 60;
    const showId = rowAt(dayOffset, hour);
    if (!showId) continue;
    const prevAbs = absMin - 60;
    const prevDay = Math.floor(prevAbs / 1440);
    const prevHour = (((prevAbs % 1440) + 1440) % 1440) / 60;
    if (rowAt(prevDay, prevHour) === showId) continue;
    out.push({
      showId,
      name: names.get(showId) || showId,
      slotKey: `${localDate(clock.year, clock.month, clock.day + dayOffset)}T${pad2(hour)}:00`,
      minutes: delta,
      startsAtMs: nowMs + (delta * 60 - clock.second) * 1000,
    });
  }
  return out;
}

const isUniqueViolation = (e: any) => e?.code === "P2002";

export type ReminderDeps = {
  send?: Send;
  schedule?: StationSchedule | null;
  now?: number;
};

/**
 * One scheduler tick. The unique ShowReminder claim is taken before the send,
 * so fifteen consecutive ticks with the same showing produce one text. A
 * failed send releases the claim, which lets the next tick retry while the
 * window is still open.
 */
export async function runReminders(deps: ReminderDeps = {}): Promise<{ sent: number; failed: number }> {
  const send = deps.send || sendText;
  if (!deps.send && !readLinqConfig().enabled) return { sent: 0, failed: 0 };

  const schedule = deps.schedule !== undefined ? deps.schedule : await fetchStationSchedule();
  if (!schedule) return { sent: 0, failed: 0 };

  const now = deps.now ?? Date.now();
  const starts = upcomingStarts(schedule.grid, schedule.shows, schedule.timezone, now, REMINDER_LEAD_MIN);
  if (starts.length === 0) return { sent: 0, failed: 0 };

  const url = publicBaseUrl();
  let sent = 0;
  let failed = 0;

  for (const start of starts) {
    const contacts = await prisma.phoneContact.findMany({
      where: {
        verifiedAt: { not: null },
        optedOutAt: null,
        showAlerts: { some: { showId: start.showId } },
      },
      select: { id: true, phone: true },
    });

    for (const contact of contacts) {
      let claim;
      try {
        claim = await prisma.showReminder.create({
          data: { contactId: contact.id, showId: start.showId, slotKey: start.slotKey },
        });
      } catch (e) {
        if (isUniqueViolation(e)) continue;
        console.warn("[textline] could not claim reminder:");
        continue;
      }

      const body = reminderBody(start.name, start.minutes, STATION.name, url);
      const res = await send(contact.phone, body, { idempotencyKey: `reminder-${contact.id}-${start.slotKey}` });
      if (res.ok) {
        await prisma.textMessage
          .create({ data: { contactId: contact.id, direction: "out", body, providerId: res.id || null } })
          .catch(() => {});
        sent++;
      } else {
        // The claim is released so a transient failure retries next tick —
        // except a 2024, which is the carrier's opt-out and would just be
        // rejected again. Record it, drop the bells, and stop.
        if (/ 2024\)/.test(res.error)) {
          await prisma.phoneContact.update({ where: { id: contact.id }, data: { optedOutAt: new Date(now) } }).catch(() => {});
          await prisma.showAlert.deleteMany({ where: { contactId: contact.id } }).catch(() => {});
        }
        await prisma.showReminder.delete({ where: { id: claim.id } }).catch(() => {});
        failed++;
        console.warn("[textline] reminder send failed:", res.error, res.traceId ? `trace ${res.traceId}` : "");
      }
    }
  }
  return { sent, failed };
}

/** Armed once from instrumentation; one tick a minute, never blocking boot. */
export function startReminderScheduler(): void {
  const g = globalThis as { __textlineTimer?: ReturnType<typeof setInterval> };
  if (g.__textlineTimer) return;
  g.__textlineTimer = setInterval(() => {
    void runReminders().catch((e) => console.warn("[textline] reminder tick failed:", e?.message || e));
  }, 60_000);
  g.__textlineTimer.unref?.();
}
