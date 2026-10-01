import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { copyDatabase } from "@/lib/dbmigrate";
import { providerFromEnv } from "@/lib/db-provider";
import { activeListeners } from "@/lib/listeners";
import { existsSync } from "node:fs";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Copy Postgres back into a new SQLite file, streamed.
 *
 * Writes to a NEW file and never touches the live one: the running database is
 * the only thing keeping the station up, so a failed revert must not be able to
 * damage it.
 *
 * Streamed like the forward copy, and for the same reason — this used to answer
 * only when it finished, so a long copy was a silent minute that looked like a
 * crash. One move flow drives both directions, and it cannot do that if one of
 * them goes quiet halfway.
 *
 * Everything the gates reject is reported as an `error` frame rather than an
 * HTTP status, because by the time the stream opens the response has already
 * begun — the client reads the frame, not the status line.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const source = providerFromEnv();
  if (source !== "postgresql") {
    return NextResponse.json(
      { error: `Already running on SQLite — there is nothing to revert from.` },
      { status: 400 }
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const targetFile = String(body?.targetFile || "").trim();
  if (!targetFile.startsWith("/") || targetFile.includes("..")) {
    return NextResponse.json(
      { error: "Give the full path of the SQLite file to write, for example /var/www/your-app/data/reverted.db" },
      { status: 400 }
    );
  }
  if (existsSync(targetFile)) {
    return NextResponse.json(
      { error: `${targetFile} already exists. Pick a new filename so an existing database is never overwritten.` },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        send("status", { text: "Checking whether anyone is listening…" });
        let listeners: Awaited<ReturnType<typeof activeListeners>> = [];
        try {
          listeners = await activeListeners();
        } catch {
          send("error", {
            message: "Cannot read the listener list, so I cannot prove the station is empty. Try again.",
          });
          return;
        }
        if (listeners.length > 0) {
          send("error", {
            message: `${listeners.length} listener(s) are still connected. Shut the station down in subwave, then copy back.`,
            listeners,
            needsEmptyRoom: true,
          });
          return;
        }

        send("status", { text: "Creating the SQLite database…" });
        const report = await copyDatabase({
          sourceProvider: "postgresql",
          sourceUrl: process.env.DATABASE_URL || "",
          targetProvider: "sqlite",
          targetUrl: `file:${targetFile}`,
          prepareTarget: true,
          onProgress: (text) => send("progress", { text }),
        });

        if (!report.ok) {
          send("error", {
            message: report.failedReason || "Copy back failed — nothing has been switched over.",
            report,
          });
          return;
        }
        send("done", { report, targetFile, sqliteUrl: `file:${targetFile}` });
      } catch (e: any) {
        send("error", { message: String(e?.message || e).trim().split("\n")[0] });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      // Not abortable without leaving a half-written file, so let it finish and
      // simply stop reporting.
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}