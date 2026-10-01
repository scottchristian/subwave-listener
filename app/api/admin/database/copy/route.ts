import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { copyDatabase } from "@/lib/dbmigrate";
import { providerFromEnv } from "@/lib/db-provider";
import { probePostgres } from "@/lib/pg-probe";
import { activeListeners } from "@/lib/listeners";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Copy the live database into a Postgres target, streamed.
 *
 * This used to answer only when it finished, which on a 7,000-row copy is a
 * long silent minute that looks exactly like a crash. Now every table is
 * reported as it lands, so the operator can see it moving and can see which
 * table it is on if it stalls.
 *
 * Server-sent events over a POST body: EventSource is GET-only, so the client
 * reads the response stream with fetch instead.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let url = "";
  try {
    const body = await req.json();
    url = String(body?.url || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "Paste the Postgres connection URL for this copy" },
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
        // Gate 1 — nobody may be listening; a restart cuts them off. There is
        // no override, and if presence cannot be read we cannot prove the room
        // is empty, so fail closed.
        send("status", { text: "Checking whether anyone is listening…" });
        let listeners: Awaited<ReturnType<typeof activeListeners>> = [];
        try {
          listeners = await activeListeners();
        } catch {
          send("error", {
            message:
              "Cannot read the listener list, so I cannot prove the station is empty. Check the database, then try again.",
          });
          return;
        }
        if (listeners.length > 0) {
          send("error", {
            message: `${listeners.length} listener(s) are still connected. Shut the station down in subwave to end their sessions, then copy again.`,
            listeners,
            needsEmptyRoom: true,
          });
          return;
        }
        send("status", { text: "Room is empty." });

        // Gate 2 — permissions, re-probed here rather than trusted from the UI.
        send("status", { text: "Checking the Postgres role…" });
        const probe = await probePostgres(url);
        if (!probe.ready) {
          send("error", {
            message: "The Postgres role cannot run the station yet. Fix the permissions below, then copy again.",
            probe,
          });
          return;
        }
        send("status", { text: `Connected as ${probe.role}. Starting the copy.` });

        const sourceProvider = providerFromEnv();
        const report = await copyDatabase({
          sourceProvider,
          sourceUrl: process.env.DATABASE_URL || "",
          targetProvider: "postgresql",
          targetUrl: url,
          prepareTarget: true,
          onProgress: (text) => send("progress", { text }),
        });

        if (!report.ok) {
          send("error", {
            message: report.failedReason || "Copy failed — nothing has been switched over.",
            report,
          });
          return;
        }
        send("done", { report });
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
      // The browser hung up. The copy itself is not abortable without leaving
      // a half-populated target, so let it finish and simply stop reporting.
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this a reverse proxy will buffer the whole stream and the
      // operator sees nothing until the copy ends — the original problem.
      "X-Accel-Buffering": "no",
    },
  });
}
