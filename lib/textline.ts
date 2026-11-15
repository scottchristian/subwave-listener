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
import { readLinqConfig, sendText, stationTextNumber, type SendResult } from "./linq";
import { fetchStationSchedule, type ScheduleShow, type StationSchedule } from "./station-schedule";

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const REMINDER_LEAD_MIN = 15;
/** One code a minute per account: each send is a real SMS to a real number. */
export const CODE_RESEND_MS = 60 * 1000;

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
 * Step one: send a code, and only then remember that a verification is
 * pending. A failed send leaves no pending row, so the UI never shows a code
 * box for a code nobody received.
 */
export async function startLink(
  userId: string,
  rawPhone: string,
  opts: { defaultCountry: string; send?: Send; now?: number }
): Promise<LinkResult> {
  const phone = normalizePhone(rawPhone, opts.defaultCountry);
  if (!phone) return fail("invalid_phone", "That doesn't look like a phone number. Try 0408 344 123 or +61 408 344 123.");

  const mine = await prisma.phoneContact.findUnique({ where: { userId }, select: { phone: true } });
  if (mine) return fail("already_linked", "Your phone is already linked.");

  const other = await prisma.phoneContact.findUnique({ where: { phone }, select: { userId: true } });
  if (other) return fail("phone_taken", "That number is already linked to another account.");

  const now = opts.now ?? Date.now();
  const pendingRow = await prisma.phoneVerification.findUnique({ where: { userId }, select: { createdAt: true } });
  if (pendingRow && now - pendingRow.createdAt.getTime() < CODE_RESEND_MS) {
    return fail("too_soon", "We've just sent a code. Give it a minute, then try again.");
  }

  const code = sixDigits();
  const send = opts.send || sendText;
  const res = await send(phone, `${code} is your ${STATION.name} code. It expires in 10 minutes.`);
  if (!res.ok) {
    // Status only — the provider's body can echo the recipient.
    console.warn("[textline] code send failed:", res.error);
    if (/not configured/.test(res.error)) {
      return fail("send_failed", "The station's text line isn't switched on. Ask the station owner to turn it on.");
    }
    const [, , linqCode = ""] = res.error.match(/\((\d{3})(?:\s+(\d{4}))?\)/) ?? [];
    // 2024 is Linq's own opt-out: any further send is rejected until that
    // person texts the line again. Never retry it, and never override it here.
    if (linqCode === "2024") {
      return fail("send_failed", "That number has asked the station to stop texting. Text the station once to start again, then try this again.");
    }
    // Line-side refusals (reputation, permissions, international plan): the
    // listener can only wait, and the owner fixing the line is what helps.
    if (["2006", "2027", "2032", "4008"].includes(linqCode)) {
      return fail("send_failed", "The station's text line can't send right now. Try again later, and let the station owner know if it keeps failing.");
    }
    // 2008 is "recipient not allowed". A sandbox account and the free Shared
    // Line are inbound-first, so no registration step lets the line text a
    // number that has not texted it; on a Shared Line the owner also adds the
    // number (20 max) in the Linq CLI before that inbound can arrive.
    if (linqCode === "2008") {
      const line = await stationTextNumber();
      return fail(
        "send_failed",
        line
          ? `The station's line can only text numbers that have texted it first. Text the station at ${line}, then try again — on the free Shared Line the owner also has to add your number, so ask if it still fails.`
          : "The station's line can only text numbers that have texted it first. Text the station once, then try again — on the free Shared Line the owner also has to add your number, so ask if it still fails."
      );
    }
    return fail("send_failed", "We couldn't send the code just now. Wait a minute and try again.");
  }

  await prisma.phoneVerification.upsert({
    where: { userId },
    create: { userId, phone, codeHash: hashCode(code), expiresAt: new Date(now + LINK_CODE_TTL_MS) },
    update: { phone, codeHash: hashCode(code), attempts: 0, createdAt: new Date(now), expiresAt: new Date(now + LINK_CODE_TTL_MS) },
  });
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
  if (!pending) return fail("no_code", "There's no code waiting. Tap Get my code first.");

  const now = opts.now ?? Date.now();
  if (pending.expiresAt.getTime() < now) {
    await prisma.phoneVerification.deleteMany({ where: { userId } });
    return fail("expired", "That code has expired. Tap Get my code to send a new one.");
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    await prisma.phoneVerification.deleteMany({ where: { userId } });
    return fail("too_many", "Too many tries. Tap Get my code to send a new one.");
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
    prisma.phoneVerification.findUnique({ where: { userId }, select: { createdAt: true, phone: true } }),
  ]);
  return {
    available: readLinqConfig().enabled,
    linked: !!contact?.verifiedAt,
    phone: contact?.phone ?? null,
    optedOut: !!contact?.optedOutAt,
    showIds: contact?.showAlerts.map((a) => a.showId) ?? [],
    codeSentAt: pending?.createdAt.toISOString() ?? null,
    pendingPhone: pending?.phone ?? null,
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
 * An inbound text. Unknown numbers are ignored (no contact, no reply): the
 * line only answers people who linked in the app. STOP records the opt-out,
 * clears every bell, and sends exactly one confirmation.
 */
export async function handleInbound(evt: InboundEvent, opts: { send?: Send; now?: number } = {}): Promise<{ handled: boolean }> {
  if (evt.isGroup) return { handled: false };
  const phone = normalizePhone(evt.phone);
  const body = String(evt.body || "").trim();
  if (!phone || !body) return { handled: false };

  const contact = await prisma.phoneContact.findUnique({ where: { phone }, select: { id: true, optedOutAt: true } });
  if (!contact) return { handled: false };

  if (evt.providerId) {
    const seen = await prisma.textMessage.findUnique({ where: { providerId: evt.providerId }, select: { id: true } });
    if (seen) return { handled: true };
  }

  const now = new Date(opts.now ?? Date.now());
  const log = (direction: string, text: string, providerId: string | null = null) =>
    prisma.textMessage.create({ data: { contactId: contact.id, direction, body: text, providerId } }).catch(() => null);

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
        console.warn("[textline] reminder send failed:", res.error);
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
