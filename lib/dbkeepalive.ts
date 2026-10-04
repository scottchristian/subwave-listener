// Keep a free-tier Postgres awake.
//
// Free tiers suspend an idle database, and the first request after a suspend
// pays a multi-second cold start — a listener pressing play waits for it.
// The fix is a periodic query from the app process, which is always running
// even when the station is idle.
//
// Why `SELECT 1` and not an insert-then-delete: a write is strictly worse for
// this job. It generates WAL, leaves a dead tuple behind, triggers autovacuum,
// takes locks, and can fail on a constraint at exactly the wrong moment. A
// read does none of that and every major provider counts it as activity — they
// suspend on *compute* idle, and a query is what keeps compute up. So the poke
// is a bare SELECT.
//
// The config lives in the env file rather than the Setting table, deliberately:
// if the database is the thing that went to sleep, reading its own
// configuration is exactly what will not work. Env is readable regardless, and
// the panel can still show and change the toggle while the database is down.
import { providerFromEnv } from "./db-provider";

export const MIN_SECONDS = 30;
export const MAX_SECONDS = 3600;
const DEFAULT_SECONDS = 300;

export type KeepAliveState = {
  enabled: boolean;
  seconds: number;
  /** True when the timer is actually scheduled. */
  running: boolean;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalPings: number;
};

type Global = typeof globalThis & {
  __cfKeepAlive?: KeepAliveState & { timer?: ReturnType<typeof setTimeout> | null };
  __cfKeepAliveStarted?: boolean;
};

const g = globalThis as Global;

function blank(): KeepAliveState {
  return {
    enabled: false,
    seconds: DEFAULT_SECONDS,
    running: false,
    lastAttemptAt: null,
    lastOkAt: null,
    lastError: null,
    consecutiveFailures: 0,
    totalPings: 0,
  };
}

// HMR and the dev server re-evaluate modules; the state must survive that or
// a reload would stack a second timer on the same database.
const s = (): NonNullable<Global["__cfKeepAlive"]> => {
  // Lazy, not initialised once at module load: if the state were ever lost
  // while the started-guard survived, a load-time initialiser would leave s()
  // undefined and the next ping would throw.
  if (!g.__cfKeepAlive) g.__cfKeepAlive = { ...blank(), timer: null };
  return g.__cfKeepAlive;
};

export function clampSeconds(n: unknown): number {
  // A blank value means "unset", not "zero". Math.floor(Number("")) is 0,
  // which would clamp to the 30s floor — so an empty DB_KEEPALIVE_SECONDS
  // would silently become the most aggressive setting available.
  if (n === null || n === undefined || String(n).trim() === "") return DEFAULT_SECONDS;
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, v));
}

/** Config from the env file. Absent settings mean "off" — never a surprise poke. */
export function readConfig(): { enabled: boolean; seconds: number } {
  const on = /^(1|true|yes|on)$/i.test(String(process.env.DB_KEEPALIVE ?? "").trim());
  return { enabled: on, seconds: clampSeconds(process.env.DB_KEEPALIVE_SECONDS) };
}

/** The query. Exported so it can be exercised without a running timer. */
export async function ping(): Promise<number> {
  const { default: prisma } = await import("./prisma");
  const t0 = Date.now();
  // A tagged template, so this can never become an injection point.
  await prisma.$queryRaw`SELECT 1`;
  return Date.now() - t0;
}

async function poke(): Promise<void> {
  // Only Postgres has a free tier that sleeps. On SQLite this would just be a
  // pointless write to a local file.
  if (providerFromEnv() !== "postgresql") {
    s().enabled = false;
    return;
  }
  s().lastAttemptAt = Date.now();
  s().totalPings += 1;
  try {
    const ms = await ping();
    s().lastOkAt = Date.now();
    s().lastError = null;
    s().consecutiveFailures = 0;
    console.log(`[keepalive] database pinged in ${ms}ms`);
  } catch (e: any) {
    s().consecutiveFailures += 1;
    // A failed ping is usually the database waking up, or being down. Record
    // it and try again next tick rather than giving up: the whole point is to
    // survive a suspend.
    s().lastError = String(e?.message || e).trim().split("\n")[0].slice(0, 200);
    console.warn(`[keepalive] ping failed (${s().consecutiveFailures}): ${s().lastError}`);
  }
}

function schedule(): void {
  const st = s();
  if (st.timer) clearTimeout(st.timer);
  if (!st.enabled) {
    st.running = false;
    st.timer = null;
    return;
  }
  st.running = true;
  // setTimeout rather than setInterval: a slow query must not queue up behind
  // itself, and the next tick is booked only once the previous one finished.
  st.timer = setTimeout(async () => {
    await poke();
    // Re-read the interval each tick so a change takes effect without a restart.
    st.seconds = readConfig().seconds;
    schedule();
  }, st.seconds * 1000);
  // Do not hold the event loop open on a serverless-ish runtime.
  (st.timer as any).unref?.();
}

/** Idempotent. Safe to call from anywhere, including on every HMR update. */
export function start(): void {
  if (g.__cfKeepAliveStarted) return;
  g.__cfKeepAliveStarted = true;
  const cfg = readConfig();
  s().enabled = cfg.enabled;
  s().seconds = cfg.seconds;
  if (cfg.enabled && providerFromEnv() !== "postgresql") {
    // Do not announce an enabled keep-alive we are about to switch off. SQLite
    // is a local file; there is no remote database to keep awake.
    console.log("[keepalive] not applicable — the station is not on Postgres");
    s().enabled = false;
    schedule();
    return;
  }
  if (cfg.enabled) {
    console.log(`[keepalive] enabled, pinging every ${cfg.seconds}s`);
    // One immediately, so a restart after a suspend does not leave the station
    // paying the cold start for the next listener.
    void poke().then(schedule);
  } else {
    schedule();
  }
}

export function stop(): void {
  s().enabled = false;
  schedule();
}

/** Apply a new configuration to the running timer without a restart. */
export function reconfigure(enabled: boolean, seconds: number): void {
  s().enabled = enabled;
  s().seconds = clampSeconds(seconds);
  if (enabled) console.log(`[keepalive] enabled, pinging every ${s().seconds}s`);
  else console.log("[keepalive] disabled");
  schedule();
}

export function snapshot(): KeepAliveState {
  // Live state wins over the boot env: reconfigure() changes the timer without
  // touching process.env, so reading the env last would report the old value
  // until the next restart — the panel would show ON right after saving OFF.
  const { timer, ...rest } = s();
  return { ...readConfig(), ...rest, running: s().running };
}
