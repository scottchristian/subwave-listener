// dbwake.ts - wake a hibernated database with exponential backoff
import { PrismaClient } from "@prisma/client";
import { providerFromEnv } from "./db-provider";
import { prismaAdapter } from "./prisma-adapter";
import {
  diagnoseDbError,
  firstMeaningfulErrorLine,
  isRetryableDiagnosis,
  type DbDiagnosis,
} from "./db-diagnosis";
import { alertGate, endAlert, gateAlert, notifyAdmins } from "./ntfy";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes default
const KNOCK_EVERY_MS = 10 * 1000; // 10 seconds between knocks

let backgroundLoop: Promise<boolean> | null = null;

/**
 * Test seam only — production never sets this.
 *
 * A sleeping database is simulated by making the shared client's reads refuse.
 * The wake path must then knock through that same connection: a fresh client
 * still reaches a real file and "wakes" a database that is, for the caller,
 * still refusing. The override is also where a simulated asleep database says
 * "no" cheaply, so a test does not sit through the full retry budget.
 *
 * `timeoutMs` is part of the same override: real backoff starts at ten seconds,
 * which a check script cannot wait for.
 */
let knockOverride: (() => Promise<boolean>) | null = null;
let timeoutOverrideMs: number | null = null;

export function setWakeKnockForTests(knock: (() => Promise<boolean>) | null, timeoutMs?: number): void {
  knockOverride = knock;
  timeoutOverrideMs = timeoutMs ?? null;
}

/** Scheme of the configured URL — for diagnosis only, never logged whole. */
function urlScheme(): string | undefined {
  const url = process.env.DATABASE_URL;
  return url ? url.trim().split(":")[0].toLowerCase() : undefined;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message || String(e) : String(e);
}

/**
 * Create a fresh Prisma client for wake attempts.
 * Using a fresh client ensures we don't use stale connection pools.
 * Uses extended connection timeout for hibernated databases.
 */
function createWakeClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const provider = providerFromEnv(undefined, url);
  // Extended connection timeout is a Postgres concept: `connect_timeout` is how
  // long libpq waits for a hibernated server, and it needs a query string.
  let wakeUrl = url;
  if (provider === "postgresql" && !/[?&]connect_timeout=/.test(url)) {
    wakeUrl = `${url}${url.includes("?") ? "&" : "?"}connect_timeout=180`;
  }
  return new PrismaClient({
    adapter: prismaAdapter(wakeUrl, provider),
    log: process.env.NODE_ENV === "development" ? ["error"] : [],
  });
}

async function knock(client: PrismaClient): Promise<{ ok: boolean; error: unknown }> {
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * One log line per failed knock, kind and reason together — this is the
 * trail the owner greps after. The raw line can carry a hostname, so it is
 * console-only; browsers get the diagnosis summary instead.
 */
function logKnockFailure(n: number, error: unknown): DbDiagnosis {
  const diagnosis = diagnoseDbError(error, urlScheme());
  console.warn(`[dbwake] knock ${n} failed [${diagnosis.kind}]: ${firstMeaningfulErrorLine(errorText(error))}`);
  return diagnosis;
}

function logNonRetryable(diagnosis: DbDiagnosis, line?: string): void {
  console.error(`[dbwake] non-retryable database error — knocking will not fix it: ${diagnosis.summary}`);
  // A permanent failure pages the owner once (the gate suppresses repeats
  // while it stands); recovery is sent by wakeDbForRequest once a knock
  // succeeds again. The raw line is console-only, same rule as the log above.
  const gate = gateAlert(alertGate(), "db-permanent", Date.now());
  if (gate.send) {
    void notifyAdmins(
      "Database misconfigured",
      `${diagnosis.summary}\n${line ?? ""}`,
      { priority: 5, tags: ["rotating_light"] }
    );
  }
}

export async function wakeDb(opts?: { timeoutMs?: number; onAttempt?: (n: number) => void }): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? timeoutOverrideMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let n = 0;
  let lastDiagnosis: DbDiagnosis | null = null;
  let lastLine: string | undefined;
  for (;;) {
    n++;
    if (knockOverride) {
      if (await knockOverride().catch(() => false)) return true;
    } else {
      const client = createWakeClient();
      try {
        const r = await knock(client);
        if (r.ok) return true;
        lastDiagnosis = logKnockFailure(n, r.error);
        lastLine = firstMeaningfulErrorLine(errorText(r.error));
      } finally {
        await client.$disconnect().catch(() => {});
      }
    }
    if (lastDiagnosis && !isRetryableDiagnosis(lastDiagnosis)) logNonRetryable(lastDiagnosis, lastLine);
    opts?.onAttempt?.(n);
    if (Date.now() - started >= timeoutMs) return false;
    // Exponential backoff: start at 10s, max 60s
    const delay = Math.min(KNOCK_EVERY_MS * Math.pow(1.5, n - 1), 60_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Shared background loop: concurrent callers join the running one. */
export function wakeDbInBackground(): Promise<boolean> {
  if (!backgroundLoop) {
    console.log("[dbwake] database unreachable — knocking until it answers");
    backgroundLoop = wakeDb({
      onAttempt: (n) => {
        if (n % 6 === 1) console.log(`[dbwake] still knocking (attempt ${n})`);
      },
    }).then((ok) => {
      console.log(ok ? "[dbwake] database awake" : "[dbwake] gave up — will retry on the next visit");
      backgroundLoop = null;
      return ok;
    });
  }
  return backgroundLoop;
}

export type WakeOutcome = {
  woke: boolean;
  /** Why the last knock failed, when it did. Safe to show to a browser. */
  diagnosis: DbDiagnosis | null;
};

/**
 * Wake the database with a short timeout, suitable for a single request path
 * that needs the database immediately. Does not share the background loop.
 * Uses a fresh Prisma client each attempt with extended connection timeout.
 *
 * A knock that fails with a PERMANENT error (wrong engine, wrong credentials,
 * missing URL) ends the loop immediately: the diagnosis is returned and the
 * caller can say why instead of sitting out the full timeout and guessing.
 */
export async function wakeDbForRequest(timeoutMs = 10_000): Promise<WakeOutcome> {
  const started = Date.now();
  let n = 0;
  for (;;) {
    n++;
    let error: unknown = null;
    let ok = false;
    try {
      const client = createWakeClient();
      try {
        const r = await knock(client);
        ok = r.ok;
        error = r.error;
      } finally {
        await client.$disconnect().catch(() => {});
      }
    } catch (e) {
      // createWakeClient itself can fail (no URL) — that is a knock failure,
      // not a reason to 500 the endpoint without a word.
      error = e;
    }
    if (ok) {
      if (n > 1) console.log(`[dbwake] request wake succeeded on attempt ${n}`);
      // A successful knock clears an open permanent-failure alert — recovery
      // always notifies and re-arms the gate for the next incident.
      if (alertGate().has("db-permanent")) {
        endAlert(alertGate(), "db-permanent");
        void notifyAdmins(
          "Database reachable again",
          "The database answers again — the permanent-failure alert is cleared.",
          { priority: 3, tags: ["white_check_mark"] }
        );
      }
      return { woke: true, diagnosis: null };
    }
    const diagnosis = logKnockFailure(n, error);
    if (!isRetryableDiagnosis(diagnosis)) {
      logNonRetryable(diagnosis, firstMeaningfulErrorLine(errorText(error)));
      return { woke: false, diagnosis };
    }
    if (Date.now() - started >= timeoutMs) return { woke: false, diagnosis };
    // Exponential backoff for request-scoped wake too
    const delay = Math.min(5_000 * Math.pow(1.5, n - 1), 30_000);
    await new Promise((r) => setTimeout(r, delay));
  }
}