/**
 * Why a database touch failed, in two channels for two audiences.
 *
 * The kind + summary let a listener read what is happening, and let the code
 * decide whether retrying can help. A permanent configuration error must not
 * be retried like a sleeping database — that is the difference between "Please
 * wait" for a moment and "Please wait" forever.
 *
 * The summary is safe to show on a public, unauthenticated page: it never
 * carries the database URL, a hostname, or credentials, all of which can
 * appear inside a raw driver error. The owner gets the full error line in the
 * server logs next to the same kind, which is what makes a pm2 log grep
 * enough to diagnose.
 *
 * This module is pure: no node builtins, no env reads, so the client bundle
 * can import it too.
 */

export type DbErrorKind = "sleeping" | "mismatch" | "auth" | "unknown";

export type DbDiagnosis = {
  kind: DbErrorKind;
  /** Public-safe, a sentence or two, no URLs or secrets. */
  summary: string;
};

/**
 * May another attempt fix this? Only a sleeping/unreachable database gets
 * retries; "unknown" does too, because a cold start can look like anything.
 * A misconfiguration or rejected credentials will fail identically every
 * time, and each retry is another confusing minute for the listener.
 */
export function isRetryableDiagnosis(d: DbDiagnosis | null): boolean {
  return !d || d.kind === "sleeping" || d.kind === "unknown";
}

const PROTOCOL_NAMES: Record<string, string> = {
  file: "SQLite",
  postgres: "Postgres",
  postgresql: "Postgres",
  mysql: "MySQL",
  mongodb: "MongoDB",
};

function providerName(protocol: string): string {
  // The protocol regex captures "file:" with its trailing colon.
  const key = protocol.toLowerCase().replace(/:$/, "");
  return PROTOCOL_NAMES[key] || `a ${key} database`;
}

/**
 * The line of a (usually multi-line) driver error that says what actually
 * went wrong. Prisma errors bury the reason under a boilerplate first line —
 * "Invalid `prisma.account.findUnique()` invocation:" — which is exactly the
 * line a naive split("\n")[0] picks and all the log showed during a real
 * outage. Prefer the first line containing "error:", fall back to the first
 * non-empty line. Logs only: callers must not forward this to a browser,
 * since it can carry hostnames.
 */
export function firstMeaningfulErrorLine(raw: string | null | undefined): string {
  if (!raw) return "unknown error";
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const withDetail = lines.find((l) => /error:/i.test(l)) || lines[0] || "unknown error";
  return withDetail.replace(/\s+/g, " ").slice(0, 240);
}

/**
 * Classify a raw database error. `urlScheme` is the scheme of the configured
 * DATABASE_URL (never the URL itself) and sharpens the mismatch wording when
 * the error text only names the side the client was built for.
 */
export function diagnoseDbError(raw: unknown, urlScheme?: string): DbDiagnosis {
  const message =
    raw instanceof Error
      ? `${raw.message || ""} ${(raw as any)?.code || ""}`
      : typeof raw === "string"
        ? raw
        : `${String(raw ?? "")} ${(raw as any)?.code || ""}`;
  const line = firstMeaningfulErrorLine(message);
  const lower = message.toLowerCase();

  // Client built for one engine, URL pointing at another. Prisma 5 says so
  // outright ("the URL must start with the protocol `file:`"); either way no
  // number of retries fixes it — the configuration has to change.
  const expected = lower.match(/must start with the protocol `([^`]+)`/)?.[1];
  if (expected) {
    const actual = urlScheme ? providerName(urlScheme) : "a different kind of database";
    return {
      kind: "mismatch",
      summary:
        `The station's database is misconfigured: it was built for ${providerName(expected)} ` +
        `but is being pointed at ${actual}. Waiting will not fix this — the station owner ` +
        `needs to check the database configuration.`,
    };
  }

  if (/database_url not set|database_url is missing|missing.*database_url/i.test(lower)) {
    return {
      kind: "mismatch",
      summary:
        "The station has no database address configured at all. Waiting will not fix this — " +
        "the station owner needs to check the database configuration.",
    };
  }

  if (/password authentication failed|28p01|no pg_hba\.conf entry|access denied|mysql.*1045/i.test(lower)) {
    return {
      kind: "auth",
      summary:
        "The database is rejecting the station's login credentials. Waiting will not fix " +
        "this — the station owner needs to check the database configuration.",
    };
  }

  if (
    /p1001|p1002|p1008|p1017|can't reach database server|connection refused|econnrefused|etimedout|timed out|timeout|57p01|08006|08001|53300|canceled|terminated/i.test(
      lower
    )
  ) {
    return {
      kind: "sleeping",
      summary: "The database is not answering — it may be waking up. This usually only takes a moment.",
    };
  }

  return {
    kind: "unknown",
    summary: "The database returned an unexpected error. The station owner can find the details in the server logs.",
  };
}
