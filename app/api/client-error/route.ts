import { NextResponse } from "next/server";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where a browser render crash goes.
 *
 * A production React error is a minified number and its component stack is only
 * ever visible in a developer console, which means diagnosing one normally means
 * asking a listener to open Web Inspector. This writes it where the operator can
 * already look, so a crash can be identified from the server.
 *
 * Deliberately a FILE, on local disk, never the database: this fires exactly
 * when things are broken, and a report about breakage must not depend on the
 * thing that is broken. It is also why the app's own audit log is local disk too.
 *
 * No auth: a crash can happen during sign-in, when there is no session, and a
 * reporter that needs one silently drops the report it exists to keep.
 *
 * PRIVACY: writes only what CaptureBoundary sends — an error message and a
 * component stack. No cookies, no tokens, no session, no track metadata. Both
 * fields are length-capped and the whole thing is truncated, so a pathological
 * payload cannot fill the disk.
 */

export const runtime = "nodejs";

const MAX_FIELD = 4000;
const MAX_BODY = 8000;
const DIR = process.env.CLIENT_ERROR_LOG_DIR || path.join(process.cwd(), "data");

/**
 * Ceiling on the log, because this endpoint is deliberately open (see the PUBLIC
 * list in proxy.ts) and that makes it publicly writable. Anything can POST here,
 * so the file must not be something anyone can grow without bound — past this it
 * stops recording rather than filling the disk the station runs on.
 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function oneLine(v: unknown, cap = MAX_FIELD): string {
  return String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, cap);
}

export async function POST(req: Request) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const entry = [
    JSON.stringify({
      at: oneLine(body?.at, 40),
      name: oneLine(body?.name, 80),
      message: oneLine(body?.message, 500),
      componentStack: oneLine(body?.componentStack, MAX_FIELD),
      ua: oneLine(req.headers.get("user-agent"), 200),
    }).slice(0, MAX_BODY),
  ].join("\n");

  try {
    mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, "client-errors.log");
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0; // not there yet
    }
    if (size < LOG_MAX_BYTES) {
      appendFileSync(file, entry + "\n");
    }
  } catch {
    // A full disk or a read-only mount must not turn a crash into a 500 storm.
  }

  // 204: the client is not waiting on this and there is nothing to say back.
  return new NextResponse(null, { status: 204 });
}
