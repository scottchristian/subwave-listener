import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { enc, idx } from "@/lib/pii";
import { getSubwaveConfig } from "@/lib/subwave";

/**
 * Buy Me A Coffee donation webhook.
 *
 * BMAC is the only donation source wired up. Everything else that could reach
 * this URL is rejected, and the only thing that can make a payload count is
 * possession of the shared webhook secret: the signature is an HMAC-SHA256 over
 * the exact request body, so a stranger cannot forge one, and it covers the body
 * so they cannot tamper with an amount either.
 *
 * Fails closed at every step: no secret configured, no signature, a signature
 * that does not match, or a body that is not JSON all reject.
 */

/** Header names BMAC has used for the signature; first non-empty wins. */
const SIGNATURE_HEADERS = ["x-bmac-signature", "x-signature-sha256", "x-signature"];

/** A donation is a positive amount of money. Anything else is not one. */
function parseAmount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return null;
  // Catches negatives, zero and absurd values from a malformed or hostile body.
  if (n <= 0 || n > 100_000) return null;
  return Math.round(n * 100) / 100;
}

/** How close two identical-looking donations must be to count as a replay. */
const REPLAY_WINDOW_MS = 120_000;

/**
 * The provider's own id for the payment, if the payload names one.
 *
 * BMAC has used more than one field name for it over the years, so every
 * plausible spelling is accepted. Capped in length because this lands in a
 * unique index and an unbounded string from the internet is not worth storing.
 */
function externalIdFrom(payload: any, data: any): string | null {
  const raw =
    data?.transaction_id ?? data?.payment_id ?? data?.donation_id ??
    data?.id ?? payload?.id;
  if (raw === null || raw === undefined) return null;
  const id = String(raw).trim();
  if (!id || id.length > 128) return null;
  return id;
}

/** Constant-time compare, so a wrong signature cannot be found by timing. */
function signatureMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expected.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const secret = (await getSubwaveConfig()).bmacWebhookSecret;
    if (!secret) {
      // Deliberately vague to the caller, explicit in our own logs: without a
      // secret nothing can be verified, so nothing may be accepted.
      console.error("[bmac] No webhook secret configured — rejecting. Set BMAC_WEBHOOK_SECRET.");
      return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
    }

    let signature = "";
    for (const h of SIGNATURE_HEADERS) {
      const v = req.headers.get(h);
      if (v) { signature = v; break; }
    }
    if (!signature) {
      // Note what we do NOT do here: log the request headers. They are entirely
      // attacker-controlled, and this log is not encrypted at rest — so dumping
      // them lets a stranger inject arbitrary lines into the operator's log and,
      // if they ever send a cookie or authorization header, have it written to
      // disk. The header name we looked for is enough to debug with.
      console.warn(`[bmac] Rejected: none of ${SIGNATURE_HEADERS.join(", ")} present`);
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const bodyText = await req.text();
    const calculated = createHmac("sha256", secret).update(bodyText).digest("hex");
    if (!signatureMatches(signature, calculated)) {
      console.warn("[bmac] Rejected: signature mismatch");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Past this point the payload is genuinely from BMAC.
    let payload: any;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
    }
    const eventData = payload?.data || payload;

    const supporterEmail = eventData?.support_email || eventData?.supporter_email || eventData?.payer_email;
    const supporterName = eventData?.supporter_name || eventData?.payer_name || null;
    const amount = parseAmount(eventData?.amount);
    const currency = String(eventData?.currency || "AUD").slice(0, 8);
    const message = eventData?.support_note ? String(eventData.support_note).slice(0, 2000) : null;

    if (!supporterEmail || amount === null) {
      console.warn(
        "[bmac] Rejected: unusable payload. keys=",
        JSON.stringify(Object.keys(eventData || {})),
        "amount=",
        JSON.stringify(eventData?.amount)
      );
      return NextResponse.json({ error: "Missing or invalid email/amount" }, { status: 400 });
    }

    // The payload is full of plaintext addresses and names. Logging it raw put
    // supporter PII into the pm2 logs, which — unlike the database — are not
    // encrypted at rest. Log the shape and the money instead, with the person
    // reduced to their blind index.
    console.log("[bmac] donation received:", {
      amount,
      currency,
      hasSupporterName: !!supporterName,
      hasMessage: !!message,
      supporterIdx: idx(supporterEmail),
      type: payload.type ?? null,
    });

    // Email is stored as a blind index, so compare tokens rather than addresses.
    const supporterIdx = idx(supporterEmail);
    const user = supporterIdx
      ? await prisma.user.findUnique({ where: { email: supporterIdx } })
      : null;

    // Replay guard. A signature only proves the payload came from Buy Me A
    // Coffee — it says nothing about it being seen once. Anyone who captures a
    // genuine delivery could otherwise post it again for as much income as they
    // liked, so a repeat has to be recognised rather than counted.
    const externalId = externalIdFrom(payload, eventData);
    if (externalId) {
      const seen = await prisma.donation.findUnique({ where: { externalId } });
      if (seen) {
        console.log("[bmac] duplicate ignored, external id already recorded");
        return NextResponse.json({ success: true, duplicate: true });
      }
    } else {
      // No id to key on, so fall back to refusing an identical donation moments
      // apart. Genuine repeat tips from one person inside two minutes are rare;
      // silently dropping one is far cheaper than inflating the totals.
      const since = new Date(Date.now() - REPLAY_WINDOW_MS);
      const twin = await prisma.donation.findFirst({
        where: {
          supporterEmailIdx: supporterIdx,
          amount,
          currency,
          receivedAt: { gte: since },
        },
        select: { id: true },
      });
      if (twin) {
        console.log(
          "[bmac] duplicate ignored: identical donation within",
          REPLAY_WINDOW_MS / 1000,
          "s and no provider id in the payload"
        );
        return NextResponse.json({ success: true, duplicate: true });
      }
    }

    try {
      await prisma.donation.create({
        data: {
          userId: user ? user.id : null,
          supporterEmail: enc(supporterEmail) as string,
          supporterEmailIdx: supporterIdx,
          supporterName: enc(supporterName),
          amount,
          currency,
          message,
          ...(externalId ? { externalId } : {}),
        },
      });
    } catch (err: any) {
      // Two deliveries raced and the unique index caught the second. Count it as
      // handled so Buy Me A Coffee stops retrying, but do not count the money.
      if (err?.code === "P2002") {
        console.log("[bmac] duplicate ignored: unique constraint caught a concurrent replay");
        return NextResponse.json({ success: true, duplicate: true });
      }
      throw err;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[bmac] webhook error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// Anything other than POST is not a webhook delivery.
export async function GET() {
  return NextResponse.json(
    { error: "This is a Buy Me A Coffee webhook endpoint. It accepts POST only." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
