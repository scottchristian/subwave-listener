import prisma from "./prisma";
import { getSubwaveConfig, subwaveAdminAuth } from "./subwave";
import { sendText } from "./linq";
import {
  BOOTH_ACK,
  BOOTH_BUSY,
  boothTimeoutSec,
  composeBoothReply,
} from "./booth";

// Forwards a texted request to the booth and tells the listener what happened.
//
// Shapes:
//   queued   — the text arrived while the station was live; nobody has sent it.
//   sending  — claimed by this worker, ack sent, POST in flight.
//   accepted — the host returned a request id. Polled until answered or the
//              admin-configured deadline (default 60s) passes.
//   replied  — the follow-up text went out (booth answer, refusal, or busy).
//   failed   — no follow-up was possible: no host configured, contact opted out,
//              or Linq refused the text.
//
// One send at a time, like the skill runner: the host resolves with an LLM and
// the three concurrent texts a busy queue could produce would only contend.
// Polls run alongside, because a slow request must not stop the next text's ack.

/** The POST is a receipt only; the host answers 202 before doing any work. */
const SEND_TIMEOUT_MS = 15_000;
/** A poll tick must not hold the loop; the deadline is what bounds waiting. */
const POLL_TIMEOUT_MS = 8_000;
/** While there is work: poll this often. */
const POLL_MS = 3_000;
/** Empty queue: sleep until a text nudges the worker (queue is only filled by us). */
const IDLE_MS = 5 * 60 * 1000;
const MAX_POLL_ROWS = 25;
/** A send that outlived every timeout is stuck, not in flight. */
const STUCK_SEND_MS = 90_000;

type SendFn = (to: string, body: string) => Promise<{ ok: boolean; id?: string | null; error?: string }>;

export type BoothTickOptions = {
  now?: number;
  send?: SendFn;
  fetchImpl?: typeof fetch;
};

const STATE = Symbol.for("subwave.boothWorker");
type WorkerState = { started: boolean; wake: (() => void) | null; nudged: boolean };
const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
const state: WorkerState = g[STATE] ?? (g[STATE] = { started: false, wake: null, nudged: false });

/** Wake the loop for a row just queued; a nudge mid-run is kept, not lost. */
export function nudgeBoothWorker() {
  state.nudged = true;
  state.wake?.();
}

export async function enqueueBoothRequest(input: {
  contactId: string;
  phone: string;
  name: string;
  body: string;
}) {
  const row = await prisma.textlineRequest.create({
    data: { ...input, status: "queued" },
    select: { id: true },
  });
  nudgeBoothWorker();
  return row;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      state.wake = null;
      resolve();
    }
    state.wake = done;
  });
}

async function tell(
  row: { id: string; contactId: string; phone: string },
  text: string,
  opts: BoothTickOptions
): Promise<boolean> {
  // Opt-out beats everything, including a reply already composed: Linq refuses
  // texts to a chat marked OPTED_OUT, and the listener asked us to stop.
  const contact = await prisma.phoneContact
    .findUnique({ where: { id: row.contactId }, select: { optedOutAt: true } })
    .catch(() => null);
  if (!contact || contact.optedOutAt) return false;

  try {
    const res = await (opts.send || sendText)(row.phone, text);
    if (!res.ok) {
      console.warn("[booth] text not sent:", res.error || "unknown error");
      return false;
    }
    await prisma.textMessage
      .create({
        data: { contactId: row.contactId, direction: "out", body: text, providerId: res.id ?? null },
      })
      .catch(() => null);
    return true;
  } catch (err) {
    console.warn("[booth] text send failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

const settle = (
  id: string,
  status: string,
  error: string | null,
  repliedAt: Date | null = null
) =>
  prisma.textlineRequest.update({
    where: { id },
    data: { status, error, repliedAt },
  });

async function runSend(
  row: { id: string; contactId: string; phone: string; name: string; body: string },
  opts: BoothTickOptions,
  now: number
) {
  const cfg = await getSubwaveConfig();
  const auth = subwaveAdminAuth(cfg);
  if (!cfg.apiUrl || !auth) {
    // Nothing to text either: the station cannot reach its own booth, and that
    // is an operator problem, not the listener's.
    await settle(row.id, "failed", "Sub/Wave is not configured, so the request could not be sent.");
    console.warn("[booth] request", row.id.slice(0, 12), "not sent — Sub/Wave credentials are missing");
    return;
  }

  const contact = await prisma.phoneContact
    .findUnique({ where: { id: row.contactId }, select: { optedOutAt: true } })
    .catch(() => null);
  if (!contact || contact.optedOutAt) {
    await settle(row.id, "failed", "The contact opted out before this request went out.");
    return;
  }

  // Acknowledge before the booth is asked, because the promise is "we got it",
  // not "the booth accepted it". A refusal below gets its own follow-up.
  await tell(row, BOOTH_ACK, opts);

  const timeoutSec = await boothTimeoutSec();
  let res: Response;
  try {
    res = await (opts.fetchImpl || fetch)(`${cfg.apiUrl}/request`, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json",
        // The host counts each listener separately only for an admin-
        // authenticated caller; this id is what keeps two listeners off one
        // cooldown.
        "x-request-client": row.contactId,
      },
      body: JSON.stringify({ text: row.body, name: row.name }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    const sent = await tell(row, BOOTH_BUSY, opts);
    await settle(row.id, sent ? "replied" : "failed", "no answer from the booth", new Date(now));
    return;
  }

  const data: any = await res.json().catch(() => null);
  if (res.ok && typeof data?.requestId === "string" && data.requestId) {
    await prisma.textlineRequest.update({
      where: { id: row.id },
      data: {
        status: "accepted",
        hostId: data.requestId,
        deadlineAt: new Date(now + timeoutSec * 1000),
      },
    });
    console.log(`[booth] request ${row.id.slice(0, 12)} accepted — ${timeoutSec}s to answer`);
    return;
  }

  // The host's own refusals are already listener-safe copy ("Easy there — try
  // again in 45s.", "The request queue's full…").
  const message =
    typeof data?.message === "string" && data.message.trim() ? data.message.trim() : BOOTH_BUSY;
  const sent = await tell(row, message, opts);
  await settle(row.id, sent ? "replied" : "failed", `the booth refused it (${res.status})`, new Date(now));
}

async function runPoll(
  row: { id: string; contactId: string; phone: string; hostId: string | null },
  opts: BoothTickOptions,
  now: number
) {
  if (!row.hostId) return;
  const cfg = await getSubwaveConfig();
  let res: Response;
  try {
    res = await (opts.fetchImpl || fetch)(`${cfg.apiUrl}/request/${row.hostId}`, {
      method: "GET",
      headers: { "x-station-auth": cfg.stationPassword },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // A missed poll is not an answer; the deadline still fires on time.
    return;
  }

  if (res.status === 404) {
    // The host's ledger is in memory; a restart loses it. The track may still
    // air, but nothing can confirm a time, so say what is certain.
    const sent = await tell(row, BOOTH_BUSY, opts);
    await settle(row.id, sent ? "replied" : "failed", "the booth no longer had the request", new Date(now));
    return;
  }

  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data.status !== "string") return;
  if (data.status === "pending") return;

  if (data.status === "resolved") {
    const reply = composeBoothReply(data);
    const sent = await tell(row, reply, opts);
    const waitSec = typeof data.waitSec === "number" ? Math.round(data.waitSec) : null;
    const waitNoticeSec =
      typeof data.waitNoticeSec === "number" ? Math.round(data.waitNoticeSec) : null;
    await prisma.textlineRequest.update({
      where: { id: row.id },
      data: {
        status: sent ? "replied" : "failed",
        waitSec,
        waitNoticeSec,
        repliedAt: new Date(now),
        error: sent ? null : "the follow-up text could not be sent",
      },
    });
    return;
  }

  if (data.status === "failed") {
    const message =
      typeof data.message === "string" && data.message.trim() ? data.message.trim() : BOOTH_BUSY;
    const sent = await tell(row, message, opts);
    await prisma.textlineRequest.update({
      where: { id: row.id },
      data: {
        status: sent ? "replied" : "failed",
        repliedAt: new Date(now),
        error: sent ? null : "the follow-up text could not be sent",
      },
    });
  }
}

async function expireOverdue(opts: BoothTickOptions, now: number) {
  // A claimed send whose attempt never settled (an unexpected throw while the
  // process lived on) would otherwise hold the listener's follow-up forever.
  const stuck = await prisma.textlineRequest.findMany({
    where: { status: "sending", startedAt: { lt: new Date(now - STUCK_SEND_MS) } },
    take: MAX_POLL_ROWS,
  });
  for (const row of stuck) {
    const sent = await tell(row, BOOTH_BUSY, opts);
    await settle(row.id, sent ? "replied" : "failed", "the send to the booth stalled", new Date(now));
  }

  const overdue = await prisma.textlineRequest.findMany({
    where: { status: "accepted", deadlineAt: { lte: new Date(now) } },
    take: MAX_POLL_ROWS,
  });
  for (const row of overdue) {
    const sent = await tell(row, BOOTH_BUSY, opts);
    await settle(row.id, sent ? "replied" : "failed", "no answer from the booth in time", new Date(now));
  }
  return overdue.length + stuck.length;
}

/**
 * One pass: expire the overdue, send the oldest queued text, poll what the
 * booth has accepted. Exported so the checks can drive the whole conversation
 * against a fake host without starting the loop.
 */
export async function runBoothTick(opts: BoothTickOptions = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  let worked = (await expireOverdue(opts, now)) > 0;

  const next = await prisma.textlineRequest.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
  });
  if (next) {
    // The conditional update is the claim: two loops (a dev reload) cannot both
    // send the same text.
    const claimed = await prisma.textlineRequest.updateMany({
      where: { id: next.id, status: "queued" },
      data: { status: "sending", startedAt: new Date(now) },
    });
    if (claimed.count === 1) {
      await runSend(next, opts, now);
      worked = true;
    }
  }

  const accepted = await prisma.textlineRequest.findMany({
    where: { status: "accepted", deadlineAt: { gt: new Date(now) } },
    orderBy: { createdAt: "asc" },
    take: MAX_POLL_ROWS,
  });
  for (const row of accepted) await runPoll(row, opts, now);
  return worked || accepted.length > 0;
}

async function loop() {
  let failures = 0;
  let reported = false;

  while (true) {
    try {
      const nudged = state.nudged;
      state.nudged = false;
      const worked = await runBoothTick({});

      if (failures > 0) {
        failures = 0;
        if (reported) console.log("[booth] database reachable again");
        reported = false;
      }

      if (!nudged && !worked) {
        // Going quiet for minutes: hang up the pool first, unless someone has
        // the app open or a manual update is mid-pipeline. Closing sockets is
        // not a query, so this costs the sleep window nothing.
        const { anyoneActive } = await import("./activity");
        if (!anyoneActive()) {
          const { readJob } = await import("./update");
          const job = await readJob(process.cwd()).catch(() => null);
          if (job?.status !== "running") {
            const { disconnectDb } = await import("./prisma");
            await disconnectDb().catch(() => {});
          }
        }
      }
      await sleep(nudged || worked ? POLL_MS : IDLE_MS);
    } catch (err) {
      // One bad row must not strand every future text.
      failures++;
      if (!reported) {
        reported = true;
        console.warn(
          "[booth] cannot reach the database, so no texted requests will be forwarded until it is back:",
          err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)
        );
      }
      await sleep(Math.min(POLL_MS * Math.min(failures, 10), 30_000));
    }
  }
}

/**
 * Boot: rows left mid-flight cannot be resumed — the host's ledger died with
 * the old process, so any follow-up would be a guess. The listener was already
 * acknowledged; the next text starts clean. A `queued` row was never sent and
 * is left for the loop.
 */
export async function reconcileStrandedRequests(): Promise<number> {
  const stranded = await prisma.textlineRequest.updateMany({
    where: { status: { in: ["sending", "accepted"] } },
    data: {
      status: "failed",
      error: "The player restarted while this was waiting for the booth.",
      repliedAt: new Date(),
    },
  });
  if (stranded.count > 0) {
    console.log(`[booth] settled ${stranded.count} stranded request(s) after restart`);
  }
  return stranded.count;
}

export async function startBoothWorker() {
  if (state.started) return;
  state.started = true;

  try {
    await reconcileStrandedRequests();
  } catch (err) {
    console.error("[booth] could not reconcile stranded requests:", err);
  }

  console.log("[booth] worker started");
  loop().catch((err) => console.error("[booth] worker died:", err));
}
