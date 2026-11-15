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
  | { ok: false; error: string };

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
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        message: { parts: [{ type: "text", value: body }] },
        to: [to],
        ...(opts.overrideOptout ? { override_optout: true } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      // Keep the status and Linq's error code; the body can echo the number.
      let code = "";
      try {
        code = String(JSON.parse(text)?.error?.code ?? JSON.parse(text)?.code ?? "");
      } catch {}
      return { ok: false, error: `send failed (${res.status}${code ? ` ${code}` : ""})` };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
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
