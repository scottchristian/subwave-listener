// ntfy.ts — push alerts for the station owner, via an ntfy.sh topic.
//
// The config lives in env vars (the .env file), NOT the database — this
// channel must work exactly when the database is down, which is when the
// alerts matter. The Admin → System panel reads and writes the same values
// through /api/admin/alerts, mirroring saves into process.env so a change
// applies without a restart.
//
// Secrets hygiene: the topic and token are configuration secrets. They are
// never logged, never returned by the API (only "set or not"), and never
// appear in any error path — failure logs carry the HTTP status or error
// message and the alert title only.
//
// Unlike lib/push.ts (web push to subscribed devices), this talks to a plain
// ntfy topic the owner subscribes to on their phone; no keys, no subscriptions.

export type NtfyConfig = {
  /** Both the flag AND a non-blank topic are required. */
  enabled: boolean;
  topic: string;
  baseUrl: string;
  token: string;
};

const DEFAULT_BASE_URL = "https://ntfy.sh";
// ntfy rejects oversized bodies; cap with margin so a long error line still
// fits and the send never fails on size alone.
const BODY_MAX_CHARS = 3500;
const SEND_TIMEOUT_MS = 5000;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes between repeats

/** Config from the environment. Absent means "off" — never a surprise alert. */
export function readConfig(): NtfyConfig {
  const on = /^(1|true|yes|on)$/i.test(String(process.env.NTFY_ENABLED ?? "").trim());
  const topic = String(process.env.NTFY_TOPIC ?? "").trim();
  const rawBase = String(process.env.NTFY_BASE_URL ?? "").trim();
  const baseUrl = (rawBase || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const token = String(process.env.NTFY_TOKEN ?? "").trim();
  return { enabled: on && topic !== "", topic, baseUrl, token };
}

// HMR and the dev server re-evaluate modules; the gate, the last-sent stamp
// and the last error must survive that or a reload would re-arm every alert
// and the panel would lose its status line. Same pattern as lib/dbkeepalive.ts.
type Global = typeof globalThis & {
  __ntfyAlertGate?: Map<string, number>;
  __ntfyLastSentAt?: number | null;
  __ntfyLastError?: string | null;
};

const g = globalThis as Global;

/**
 * The live alert gate: key → timestamp of the last send. Callers read it,
 * pass it to gateAlert/endAlert, and use the returned map (same instance,
 * mutated) as the new state.
 */
export function alertGate(): Map<string, number> {
  if (!g.__ntfyAlertGate) g.__ntfyAlertGate = new Map();
  return g.__ntfyAlertGate;
}

/**
 * Pure alert gate, exported for the check suite.
 *
 * First occurrence of a key sends; repeats are suppressed until cooldownMs
 * has passed since the last send, then send again. The passed map is mutated
 * in place and also returned, so call sites can stay one-liners.
 */
export function gateAlert(
  state: Map<string, number>,
  key: string,
  now: number,
  cooldownMs: number = DEFAULT_COOLDOWN_MS
): { send: boolean; state: Map<string, number> } {
  const last = state.get(key);
  if (last === undefined || now - last >= cooldownMs) {
    state.set(key, now);
    return { send: true, state };
  }
  return { send: false, state };
}

/**
 * Recovery counterpart: ALWAYS sends and removes the key, so the next
 * occurrence of the failure is a "first occurrence" again and alerts
 * immediately. A recovery the owner never sees is worse than a duplicate.
 */
export function endAlert(
  state: Map<string, number>,
  key: string
): { send: boolean; state: Map<string, number> } {
  state.delete(key);
  return { send: true, state };
}

/** Test seam: clear the gate and the reported status. */
export function resetAlertGateForTests(): void {
  g.__ntfyAlertGate = new Map();
  g.__ntfyLastSentAt = null;
  g.__ntfyLastError = null;
}

/** What the admin GET route may report: never the topic or token themselves. */
export function lastStatus(): { lastSentAt: number | null; lastError: string | null } {
  return { lastSentAt: g.__ntfyLastSentAt ?? null, lastError: g.__ntfyLastError ?? null };
}

/**
 * Fire-and-forget from the caller's perspective: safe to `void` anywhere.
 * Returns whether the alert was delivered. Never throws — a broken alert
 * channel must never take down the path that reported the problem.
 *
 * fetchImpl is injectable so the check suite can drive it without a network.
 */
export async function notifyAdmins(
  title: string,
  body: string,
  opts?: { priority?: number; tags?: string[] },
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg.enabled) return false;

  const headers: Record<string, string> = {
    Title: title,
    Priority: String(opts?.priority ?? 3),
  };
  if (opts?.tags && opts.tags.length > 0) headers["Tags"] = opts.tags.join(",");
  if (cfg.token) headers["Authorization"] = `Bearer ${cfg.token}`;

  const text = body.length > BODY_MAX_CHARS ? body.slice(0, BODY_MAX_CHARS) : body;

  try {
    const res = await fetchImpl(`${cfg.baseUrl}/${cfg.topic}`, {
      method: "POST",
      headers,
      body: text,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = `HTTP ${res.status}`;
      g.__ntfyLastError = err;
      console.error(`[ntfy] send failed: ${err} — "${title}"`);
      return false;
    }
    g.__ntfyLastSentAt = Date.now();
    g.__ntfyLastError = null;
    console.log(`[ntfy] sent: ${title}`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message || String(e) : String(e);
    g.__ntfyLastError = msg.slice(0, 200);
    console.error(`[ntfy] send failed: ${msg} — "${title}"`);
    return false;
  }
}
