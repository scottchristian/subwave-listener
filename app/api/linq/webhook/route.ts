import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/linq";
import { handleInbound } from "@/lib/textline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Linq delivers here for every inbound text. The body is read as raw text and
 * verified BEFORE it is parsed — re-serialising parsed JSON would change the
 * bytes and break the signature. Unknown or stale signatures are refused.
 *
 * At-least-once delivery is absorbed downstream: TextMessage.providerId is
 * unique, so a redelivery of the same message is a no-op.
 */
export async function POST(req: Request) {
  const secret = String(process.env.LINQ_WEBHOOK_SECRET || "").trim();
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });

  const raw = await req.text();
  const valid = verifyWebhookSignature(secret, raw, {
    id: req.headers.get("webhook-id"),
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
  });
  if (!valid) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  let event: any = null;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (event?.event_type !== "message.received") return NextResponse.json({ ok: true });

  const data = event.data || {};
  const sender =
    data.sender_handle?.handle || data.from_handle?.handle || data.from || data.message?.from || "";
  const parts = Array.isArray(data.parts)
    ? data.parts
    : Array.isArray(data.message?.parts)
      ? data.message.parts
      : [];
  const body = parts
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p.value || ""))
    .join("\n")
    .trim();

  // A processing failure answers 500 on purpose: Linq retries 5xx for 30
  // minutes, and a dropped request is worse than a duplicate we already dedupe.
  await handleInbound({
    phone: String(sender),
    body,
    providerId: data.id || data.message?.id || null,
    isGroup: Boolean(data.chat?.is_group ?? data.is_group),
  });
  return NextResponse.json({ ok: true });
}
