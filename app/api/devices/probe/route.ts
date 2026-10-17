import { NextRequest, NextResponse } from "next/server";

/**
 * "Can this screen actually reach the station?" — the step that tells a
 * difference nobody can see.
 *
 * A device that has joined a WiFi network has NOT necessarily joined the
 * internet. Guest networks and captive portals are the common case: the screen
 * gets an address, looks connected, and cannot resolve anything. The reference
 * firmware has no check for this at all — it infers connectivity from
 * wifi.connected plus a Home Assistant API call this device does not have — so
 * without this endpoint a captive portal produces a screen that silently never
 * shows a song and never says why.
 *
 * Two failures, named separately because the fixes differ:
 *   - cannot reach this server  → the network has no route out
 *   - reaches it but cannot resolve it → a captive portal is intercepting DNS
 *
 * Unauthenticated by necessity: the screen has no token yet, and this is exactly
 * when it needs an answer. It grants nothing, reads nothing and writes nothing —
 * it returns 204 or it does not, which is the whole payload. Rate limited below
 * so it cannot be used to make the server work as a port scanner for an
 * unauthenticated caller.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  const key = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(key)) {
    return new NextResponse(null, { status: 429 });
  }

  // Answering at all IS the proof. There is deliberately no self-fetch behind
  // this: an earlier version checked a brand asset from here first and reported
  // 503 whenever that inner request failed, which is a false negative about the
  // DEVICE's network answering a question about the SERVER's.
  //
  // What the three outcomes mean, and it is the device that tells them apart:
  //
  //   204   the screen reached us over the internet, and resolved our hostname
  //         to do it
  //   429   we are up and reachable, but rate limited — still a success for the
  //         purpose of the wizard
  //   none  the request never arrived: no DNS, or a captive portal swallowed
  //         it. That is the case this endpoint exists to make visible, and it is
  //         invisible from here by definition
  return new NextResponse(null, { status: 204 });
}