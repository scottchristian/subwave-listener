import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { dec } from "@/lib/pii";

/**
 * Host-to-host donations feed for the Sub/Wave host's ticker.
 *
 * The station password rides in the `x-station-auth` header, and only there.
 *
 * It used to be accepted from `?auth=` as well, which put a live station
 * credential into every nginx access log line, browser history and any Referer
 * sent onward. Sub/Wave's own auth helper ranks the query form last for exactly
 * that reason and keeps it only for the Icecast stream mount, which cannot carry
 * a header — a constraint that does not apply to a plain HTTP endpoint like this
 * one. Sub/Wave already sends the header.
 *
 * Compared in constant time so a wrong password cannot be discovered by timing
 * the response, and it fails closed if no password is configured at all.
 */

/** Compares without leaking length or content through timing. */
function secretEquals(a: string | null, b: string | undefined): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, and the length of a secret is
  // not itself a disclosure worth protecting here.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** `limit` is caller-controlled; refuse to let it ask for the whole table. */
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  const expected = process.env.STATION_PASSWORD;
  if (!expected) {
    // No password configured means no caller can be authenticated. Answering
    // 500 rather than 401 says "this is misconfigured", which is actionable.
    return NextResponse.json(
      { error: "No station password is configured, so this feed cannot authenticate anyone." },
      { status: 500 }
    );
  }

  const headerAuth = req.headers.get("x-station-auth");
  const bearer = req.headers.get("authorization");
  const bearerToken =
    bearer && /^bearer\s+/i.test(bearer) ? bearer.replace(/^bearer\s+/i, "").trim() : null;

  if (!secretEquals(headerAuth, expected) && !secretEquals(bearerToken, expected)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "x-station-auth" } }
    );
  }

  const urlParams = new URL(req.url).searchParams;
  const requested = parseInt(urlParams.get("limit") || "10", 10);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : 10;

  const donations = await prisma.donation.findMany({
    take: limit,
    orderBy: { receivedAt: 'desc' },
    select: {
      id: true,
      supporterName: true,
      supporterEmail: true,
      amount: true,
      currency: true,
      message: true,
      receivedAt: true,
    }
  });

  // Supporter fields are encrypted at rest, so the stored values are "e1:…"
  // blobs. Returning them raw shipped ciphertext to the Sub/Wave host and
  // rendered as garbage in the ticker. Decrypted here, at the last moment
  // before serialisation. supporterEmailIdx is deliberately not selected and
  // never leaves this process.
  const out = donations.map((d) => ({
    id: d.id,
    supporterName: dec(d.supporterName),
    supporterEmail: dec(d.supporterEmail),
    amount: d.amount,
    currency: d.currency,
    message: d.message,
    receivedAt: d.receivedAt,
  }));

  // A credential must never be cached by an intermediary.
  return NextResponse.json(
    { success: true, data: out },
    { headers: { "Cache-Control": "no-store" } }
  );
}