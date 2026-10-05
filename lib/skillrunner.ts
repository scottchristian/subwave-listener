import prisma from "@/lib/prisma";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Background executor for Sub/Wave skill runs.
//
// Why this exists: `POST /dj/skill` blocks until the agent has written a line
// AND TTS has rendered and queued it — 45s of LLM plus a TTS render that can
// take 30s+ on top of the skill's own data fetch. Holding an HTTP request open
// for that is the wrong shape: it pins a browser connection, and it makes the
// request depend on a reverse-proxy read timeout we should not have to raise.
//
// So the browser POSTs, gets a row id back in milliseconds, and polls. The
// waiting happens here, in the server process, where nothing is watching a
// socket timeout.
//
// Runs are processed strictly one at a time. Two overlapping skill runs would
// both reach the same announce queue and interleave unpredictably, and serial
// execution is also the cheapest structural brake on accidental spamming —
// there is no per-user cooldown policy here, just one broadcast lane.

/** Ceiling on one run. Past this we stop waiting but cannot cancel upstream. */
const RUN_TIMEOUT_MS = 200_000;

/** How often the loop looks for work while idle. */
const IDLE_POLL_MS = 2000;

/**
 * How long the loop sleeps with an empty queue when nobody has the app open.
 * The queue is only ever filled by a signed-in user tapping a skill, and that
 * tap wakes the loop immediately (see nudgeSkillWorker) — so an empty station
 * has no reason to ask the database every 2 seconds. One check every few
 * minutes is the cost of noticing a restart-stranded row.
 */
const IDLE_EMPTY_MS = 5 * 60 * 1000;

// Survive dev hot-reload: without a global handle a module reload would start a
// second loop and two workers would race for the same row.
const STATE = Symbol.for("subwave.skillWorker");
type WorkerState = { started: boolean; processing: boolean; wake: (() => void) | null };
const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
const state: WorkerState = g[STATE] ?? (g[STATE] = { started: false, processing: false, wake: null });

/** Wake the loop early instead of waiting out the idle poll. */
export function nudgeSkillWorker() {
  state.wake?.();
}

export async function enqueueSkillRun(userId: string, name: string, label: string) {
  const run = await prisma.skillRun.create({
    data: { userId, skillName: name, skillLabel: label, status: "queued" },
    select: { id: true, status: true, queuedAt: true },
  });
  nudgeSkillWorker();
  return run;
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

/**
 * Claim the oldest queued run. The conditional update is the claim: two workers
 * racing both read the row, but only one update matches `status: "queued"`, so
 * only one sees count === 1.
 */
async function claimNext() {
  const next = await prisma.skillRun.findFirst({
    where: { status: "queued" },
    orderBy: { queuedAt: "asc" },
    select: { id: true, userId: true, skillName: true, skillLabel: true },
  });
  if (!next) return null;
  const claimed = await prisma.skillRun.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "running", startedAt: new Date() },
  });
  return claimed.count === 1 ? next : null;
}

async function executeRun(job: { id: string; skillName: string; skillLabel: string }) {
  const finish = (data: Record<string, unknown>) =>
    prisma.skillRun.update({ where: { id: job.id }, data: { ...data, finishedAt: new Date() } });

  const cfg = await getSubwaveConfig();
  const auth = subwaveAdminAuth(cfg);
  if (!auth) {
    await finish({ status: "failed", error: "Sub/Wave server credentials are not configured." });
    return;
  }

  const started = Date.now();
  console.log(`[skills] run ${job.id.slice(0, 8)} → ${job.skillName}`);
  try {
    const res = await fetch(`${cfg.apiUrl}/dj/skill`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ name: job.skillName }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      await finish({
        status: "failed",
        error: detail?.error || `Sub/Wave server returned ${res.status}.`,
      });
      return;
    }

    const data: any = await res.json().catch(() => null);
    // Four genuinely different outcomes, and 200 is not the same as "aired".
    //   deferred — rendered and queued, held to the next track boundary
    //   aired     — on air now
    //   neither   — the DJ ran and chose to stand down. Still a success.
    const status = data?.deferred ? "deferred" : data?.aired ? "aired" : "quiet";
    await finish({
      status,
      spoken: typeof data?.spoken === "string" ? data.spoken : null,
      reason: typeof data?.reason === "string" ? data.reason : null,
    });
    console.log(
      `[skills] run ${job.id.slice(0, 8)} ${status} in ${Date.now() - started}ms` +
        (typeof data?.spoken === "string" ? ` — “${data.spoken.slice(0, 60)}”` : "")
    );
  } catch {
    // Timing out does NOT mean the station stayed quiet. The call was already
    // accepted upstream and continues there without us, and Sub/Wave has no
    // cancellation and no status endpoint — so the segment may still air.
    // `unknown` is deliberately distinct from `failed`.
    await finish({
      status: "unknown",
      error:
        "The station did not report back in time. The skill may still be running and could air.",
    });
    console.log(`[skills] run ${job.id.slice(0, 8)} no answer after ${Date.now() - started}ms — may still air`);
  }
}

async function loop() {
  // Consecutive database failures, and whether we have already said so.
  //
  // The setup wizard exists so this process can run BEFORE there is a database,
  // which means on an unconfigured install this loop fails on every poll. At the
  // ordinary poll interval that is thousands of lines of identical stack traces
  // during the minutes someone is setting up, and it reads as a broken install
  // when it is a normal one. So: back off hard, say it once, and say it again
  // only if the situation changes.
  let failures = 0;
  let reported = false;

  while (true) {
    if (state.processing) break;
    state.processing = true;
    try {
      const job = await claimNext();
      if (job) await executeRun(job);
      else {
        // Nobody here, nothing queued: sleep long. A nudge (someone just
        // enqueued) cuts any sleep short and the claim above runs regardless
        // of the activity answer — the tap itself proves a user is present,
        // even if their heartbeat has not landed yet.
        const { anyoneActive } = await import("./activity");
        await sleep((await anyoneActive()) ? IDLE_POLL_MS : IDLE_EMPTY_MS);
      }
      if (failures > 0) {
        failures = 0;
        if (reported) console.log("[skills] database reachable again");
        reported = false;
      }
    } catch (err) {
      // Never let one bad row kill the worker — that would silently strand
      // every future run with nobody left to pick it up.
      failures++;
      if (!reported) {
        reported = true;
        console.warn(
          "[skills] cannot reach the database, so no skill runs will be picked up until it is back:",
          err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
        );
      }
      // A missing or unreachable database is not a transient hiccup, and retrying
      // at the poll interval just fills the log. Back off, capped, so a real
      // database coming back is still picked up within a minute or so.
      await sleep(Math.min(IDLE_POLL_MS * Math.min(failures, 12), 30_000));
    } finally {
      state.processing = false;
    }
  }
}

/**
 * Start the worker. Idempotent — safe to call from instrumentation on every
 * boot, and a no-op in a process that already has one.
 */
export async function startSkillWorker() {
  if (state.started) return;
  state.started = true;

  // Anything queued or running when this process last died is unanswerable:
  // the upstream call died with the old process and there is no status endpoint
  // to ask. Say "unknown" rather than leaving rows stuck or claiming failure.
  try {
    const stranded = await prisma.skillRun.updateMany({
      where: { status: { in: ["queued", "running"] } },
      data: {
        status: "unknown",
        error: "The player restarted while this was running. It may still have aired.",
        finishedAt: new Date(),
      },
    });
    if (stranded.count > 0) {
      console.log(`[skills] marked ${stranded.count} stranded run(s) as unknown after restart`);
    }
  } catch (err) {
    console.error("[skills] could not reconcile stranded runs:", err);
  }

  console.log("[skills] worker started");
  loop().catch((err) => console.error("[skills] worker died:", err));
}