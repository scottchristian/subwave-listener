// Database error diagnosis: classifying a raw driver error into something a
// listener can read (safe summary) and the code can branch on (retryable or
// not). Born from a real outage: the station was restarted under a stale
// pm2 env (Postgres URL, SQLite client), every query failed with "the URL
// must start with the protocol `file:`", and the sign-in screen classified it
// as a sleeping database — so it retried forever and said nothing. The
// classification and the wording it produces are the regression guard.
//
// Run: node scripts/check-db-diagnosis.mts (wired as `npm run check:db-diagnosis`).
import {
  diagnoseDbError,
  firstMeaningfulErrorLine,
  isRetryableDiagnosis,
} from "../lib/db-diagnosis.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

// The exact error the real outage produced, from the production pm2 logs.
const INCIDENT_ERROR = `Invalid \`prisma.account.findUnique()\` invocation:
error: Error validating datasource \`db\`: the URL must start with the protocol \`file:\`.
  -->  schema.prisma:13
13 |   url      = env("DATABASE_URL")`;

{
  const d = diagnoseDbError(INCIDENT_ERROR);
  ok(d.kind === "mismatch", "a SQLite client handed a Postgres URL is a mismatch, not a sleeping database", d);
  ok(!isRetryableDiagnosis(d), "and it is not retryable — knocking cannot fix a misconfiguration");
  ok(/SQLite/.test(d.summary), "the summary names the engine the station was built for", d.summary);
  ok(/Waiting will not fix this/.test(d.summary), "and says plainly that waiting will not fix it", d.summary);
}
{
  const d = diagnoseDbError(INCIDENT_ERROR, "postgresql");
  ok(/Postgres/.test(d.summary), "the configured URL's scheme sharpens the other side of the mismatch", d.summary);
}

// The log-line extractor: the reason lives on the "error:" line, not line one.
{
  const line = firstMeaningfulErrorLine(INCIDENT_ERROR);
  ok(
    /the URL must start with the protocol/.test(line),
    "the meaningful line is the reason, not the boilerplate invocation line",
    line
  );
  ok(!/\n/.test(line), "and it is one line");
}

// Retryable classes.
{
  const p1001 = new Error("database unreachable");
  (p1001 as any).code = "P1001";
  const d = diagnoseDbError(p1001);
  ok(d.kind === "sleeping", "P1001 (can't reach database) is a sleeping/unreachable database", d);
  ok(isRetryableDiagnosis(d), "and retryable — waking is exactly what it needs");
}
{
  const d = diagnoseDbError(new Error("connect ETIMEDOUT 10.0.0.1:5432"));
  ok(d.kind === "sleeping", "a connection timeout is a sleeping/unreachable database", d);
  ok(isRetryableDiagnosis(d), "and retryable");
}

// Permanent classes.
{
  const d = diagnoseDbError(new Error('password authentication failed for user "station"'));
  ok(d.kind === "auth", "rejected credentials are their own class", d);
  ok(!isRetryableDiagnosis(d), "and not retryable — the same password fails every time");
}
{
  const d = diagnoseDbError(new Error("DATABASE_URL not set"));
  ok(d.kind === "mismatch", "a missing DATABASE_URL is a configuration failure", d);
  ok(!isRetryableDiagnosis(d), "and not retryable", d);
}

// Unknown stays retryable: a cold start can look like anything, so the default
// must remain "try again", never "give up silently".
{
  const d = diagnoseDbError(new Error("disk I/O error"));
  ok(d.kind === "unknown", "an unrecognised error is unknown, not guessed", d);
  ok(isRetryableDiagnosis(d), "and retryable by default");
  ok(/server logs/.test(d.summary), "pointing the owner at the logs where the real error is", d.summary);
}

// The summary is shown on a public, unauthenticated page: it must never carry
// a URL, a hostname, or anything that looks like a credential. (The raw error
// LINE is console-only and may legitimately contain those — the summary may not.)
{
  const nasty = `ENOENT: no such file or directory, open 'postgresql://user:secret@db.internal:5432/station'
error: Error validating datasource \`db\`: the URL must start with the protocol \`file:\`.`;
  const d = diagnoseDbError(nasty);
  ok(!/:\/\//.test(d.summary), "the public summary never contains a URL", d.summary);
  ok(!/secret|db\.internal/i.test(d.summary), "nor credentials or hostnames", d.summary);
}

// Null resilience: the wake path can pass anything it caught.
ok(isRetryableDiagnosis(null) === true, "no diagnosis yet means keep trying");
ok(diagnoseDbError(null).kind === "unknown", "and a null error classifies as unknown, not a crash");

console.log(`  ${passed}/${passed + failed} db-diagnosis assertions passed`);
if (failed) process.exit(1);
