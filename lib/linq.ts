// linq.ts — the outbound seam to Linq (iMessage/SMS) and the inbound proof.
//
// Two rules from the Linq v3 guide shape this file:
//   - Never pin a `from` line and never call available_number per send. The
//     send endpoint picks the line and reuses the chat; doing otherwise breaks
//     load-balancing and can strand a conversation on a flagged line.
//   - A webhook is only an event if the signature proves it. The standard
//     headers are HMAC-SHA256 over "{id}.{timestamp}.{rawBody}" with a whsec_
//     secret, and the timestamp must be fresh.
//
// Secrets hygiene: the API key and signing secret are never logged. Failure
// paths log a status code or error class, never the key, the recipient, or the
// message body.

import crypto from "node:crypto";

const DEFAULT_API_BASE = "https://api.linqapp.com/api/partner/v3";
const SEND_TIMEOUT_MS = 8000;
const ADMIN_TIMEOUT_MS = 10_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type LinqConfig = {
  enabled: boolean;
  apiKey: string;
  webhookSecret: string;
  apiBase: string;
};

/** Absent or switched off means "no sends" — never a surprise text. */
export function readLinqConfig(): LinqConfig {
  const on = /^(1|true|yes|on)$/i.test(String(process.env.LINQ_ENABLED ?? "").trim());
  const apiKey = String(process.env.LINQ_API_KEY ?? "").trim();
  const webhookSecret = String(process.env.LINQ_WEBHOOK_SECRET ?? "").trim();
  const apiBase = String(process.env.LINQ_API_BASE ?? DEFAULT_API_BASE).trim().replace(/\/+$/, "");
  return { enabled: on && apiKey !== "", apiKey, webhookSecret, apiBase };
}

export type SendResult =
  | { ok: true; id: string; chatId: string | null }
  /** traceId is Linq's request id — safe to log, and what support asks for. */
  | { ok: false; error: string; traceId?: string };

export type SendOptions = {
  /** One courtesy confirmation after an opt-out; Linq records every use. */
  overrideOptout?: boolean;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Send one text bubble to one E.164 number. The caller owns retry policy; this
 * is a single attempt with a timeout, and it never throws.
 */
export async function sendText(to: string, body: string, opts: SendOptions = {}): Promise<SendResult> {
  const cfg = readLinqConfig();
  if (!cfg.enabled) return { ok: false, error: "text line is not configured" };
  const doFetch = opts.fetchImpl || fetch;
  try {
    const res = await doFetch(`${cfg.apiBase}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        // Linq reads idempotency_key inside the message object, not as a
        // header; a header would leave every retry able to send twice.
        message: {
          parts: [{ type: "text", value: body }],
          ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
        },
        to: [to],
        ...(opts.overrideOptout ? { override_optout: true } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      // Keep the status, Linq's error code and its trace id — never the rest,
      // since the body can echo the recipient.
      const code = String(parsed?.error?.code ?? parsed?.code ?? "");
      const traceId = String(parsed?.trace_id ?? "");
      return {
        ok: false,
        error: `send failed (${res.status}${code ? ` ${code}` : ""})`,
        ...(traceId ? { traceId } : {}),
      };
    }
    return {
      ok: true,
      id: String(parsed?.message?.id || ""),
      chatId: parsed?.chat_id ? String(parsed.chat_id) : null,
    };
  } catch (err: any) {
    const name = err?.name === "TimeoutError" ? "timeout" : "network";
    return { ok: false, error: `send failed (${name})` };
  }
}

export type WebhookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

/** Standard Webhooks: whsec_ base64 key over "{id}.{timestamp}.{body}". */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  headers: WebhookHeaders,
  nowMs: number = Date.now()
): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Replays are the cheap attack: a captured body re-sent hours later is not
  // an event. Linq signs every attempt afresh, so five minutes is generous.
  if (Math.abs(nowMs - ts * 1000) > MAX_CLOCK_SKEW_MS) return false;

  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const part of signature.trim().split(/\s+/)) {
    if (!part.startsWith("v1,")) continue;
    let got: Buffer;
    try {
      got = Buffer.from(part.slice(3), "base64");
    } catch {
      continue;
    }
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
  }
  return false;
}

// ------------------------------------------------------- station line number
//
// Linq onboards a new contact inbound-first: the recipient texts the line
// before the line can text them, so the number that shows a listener where to
// start is worth having. Looked up once and cached — available_number is not
// a per-send call.

const NUMBER_CACHE_MS = 10 * 60 * 1000;
// Keyed by the API key: replacing the key in the admin panel must not keep
// showing the previous line. Needs only the key, not LINQ_ENABLED, so the
// panel can prove a freshly saved key by naming the line it owns.
let numberCache: { at: number; key: string; number: string } | null = null;

/** The station's own line as E.164, or null when it can't be known. */
export async function stationTextNumber(
  opts: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const cfg = readLinqConfig();
  if (numberCache && numberCache.key === cfg.apiKey && now - numberCache.at < NUMBER_CACHE_MS) {
    return numberCache.number;
  }
  if (!cfg.apiKey) return null;
  try {
    const res = await (opts.fetchImpl || fetch)(`${cfg.apiBase}/available_number`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const digits = String(data?.phone_number ?? "").replace(/[^\d+]/g, "");
    const number = digits.startsWith("+") ? digits : digits ? `+${digits}` : "";
    if (!/^\+\d{8,15}$/.test(number)) return null;
    numberCache = { at: now, key: cfg.apiKey, number };
    return number;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- webhook subscriptions
//
// The admin panel creates the subscription instead of asking the operator to
// run `linq webhooks create`: Linq returns the signing secret exactly once, and
// a secret copied by hand is the step people get wrong. These calls are
// admin-only and rare — one per setup — so each is a single timed attempt.

/** The only event the station handles: an inbound text. */
export const WEBHOOK_EVENT = "message.received";

export type WebhookSubscription = {
  id: string;
  targetUrl: string;
  events: string[];
  active: boolean;
};

export type ApiFailure = { ok: false; error: string; status?: number };

type ApiAttempt = { ok: true; data: any } | ApiFailure;

async function apiRequest(
  path: string,
  init: { method: string; body?: unknown },
  fetchImpl?: typeof fetch
): Promise<ApiAttempt> {
  const cfg = readLinqConfig();
  if (!cfg.apiKey) return { ok: false, error: "no API key saved" };
  try {
    const res = await (fetchImpl || fetch)(`${cfg.apiBase}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      // Status and Linq's error code only — never the response body.
      const code = String(parsed?.error?.code ?? parsed?.code ?? "");
      return {
        ok: false,
        error: `Linq request failed (${res.status}${code ? ` ${code}` : ""})`,
        status: res.status,
      };
    }
    return { ok: true, data: parsed ?? {} };
  } catch (err: any) {
    const name = err?.name === "TimeoutError" ? "timeout" : "network";
    return { ok: false, error: `Linq request failed (${name})` };
  }
}

export async function listWebhookSubscriptions(
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<{ ok: true; subscriptions: WebhookSubscription[] } | ApiFailure> {
  const res = await apiRequest("/webhook-subscriptions", { method: "GET" }, opts.fetchImpl);
  if (!res.ok) return res;
  const rows = Array.isArray(res.data?.subscriptions) ? res.data.subscriptions : [];
  return {
    ok: true,
    subscriptions: rows.map((s: any) => ({
      id: String(s?.id ?? ""),
      targetUrl: String(s?.target_url ?? ""),
      events: Array.isArray(s?.subscribed_events) ? s.subscribed_events.map(String) : [],
      active: s?.is_active !== false,
    })),
  };
}

/**
 * Register one HTTPS target for inbound texts. The returned signing secret
 * cannot be fetched again, so the caller must persist it before moving on.
 */
export async function createWebhookSubscription(
  targetUrl: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<{ ok: true; id: string; signingSecret: string } | ApiFailure> {
  const res = await apiRequest(
    "/webhook-subscriptions",
    { method: "POST", body: { target_url: targetUrl, subscribed_events: [WEBHOOK_EVENT] } },
    opts.fetchImpl
  );
  if (!res.ok) return res;
  const signingSecret = String(res.data?.signing_secret ?? "").trim();
  if (!signingSecret) return { ok: false, error: "Linq did not return a signing secret" };
  return { ok: true, id: String(res.data?.id ?? ""), signingSecret };
}

/** A subscription already gone is the outcome the caller wanted. */
export async function deleteWebhookSubscription(
  id: string,
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<{ ok: true } | ApiFailure> {
  const res = await apiRequest(
    `/webhook-subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    opts.fetchImpl
  );
  if (!res.ok) return res.status === 404 ? { ok: true } : res;
  return { ok: true };
}
