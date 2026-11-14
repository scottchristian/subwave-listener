// The station-status decision layer: when an unauthenticated listener is
// offered a sign-in button, and when they are not.
//
// The rule under test, in both directions:
//   - a deploy in flight (maintenance flag) ALWAYS means "updating", even if
//     the database would answer — signing in mid-deploy is how a listener
//     ends up on a white screen;
//   - only a PERMANENT database failure means "degraded" — a sleeping
//     database is transient and the sign-in page's retry loop owns it;
//   - an unreachable /api/status fails OPEN to "signin": a working station
//     with a hidden button is worse than a broken one with a visible button.
// Run: node scripts/check-station-status.mts (wired as `npm run check:station-status`).
import {
  presentSigninSurface,
  statusFromProbe,
  type StationStatusPayload,
} from "../lib/station-status.ts";
import { diagnoseDbError, type DbDiagnosis } from "../lib/db-diagnosis.ts";

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

// The verbatim error from the November incident: a SQLite-built client
// pointed at a Postgres URL.
const INCIDENT = "Error validating datasource `db`: the URL must start with the protocol `file:`.";
const mismatch: DbDiagnosis = diagnoseDbError(INCIDENT, "postgresql");
const sleeping: DbDiagnosis = diagnoseDbError("Can't reach database server at db.internal:5432");
ok(mismatch.kind === "mismatch", "the incident error classifies as a permanent mismatch", mismatch);
ok(sleeping.kind === "sleeping", "and a refused connection as a transient sleeping database", sleeping);

// ---------------------------------------------------------- route-side fold

ok(
  statusFromProbe({ maintenanceFlagPresent: true, woke: true, diagnosis: null }).status === "updating",
  "the maintenance flag wins even over a healthy database"
);
ok(
  statusFromProbe({ maintenanceFlagPresent: true, woke: false, diagnosis: mismatch }).status === "updating",
  "and over a permanent failure too — a deploy is a deploy"
);
{
  const p = statusFromProbe({ maintenanceFlagPresent: false, woke: true, diagnosis: null });
  ok(p.status === "ok", "a healthy database with no flag is ok", p);
}
{
  const p = statusFromProbe({ maintenanceFlagPresent: false, woke: false, diagnosis: mismatch });
  ok(p.status === "degraded", "a permanent failure with no flag is degraded", p);
  ok(p.diagnosis === mismatch, "and it carries the diagnosis through untouched");
}
{
  const p = statusFromProbe({ maintenanceFlagPresent: false, woke: false, diagnosis: sleeping });
  ok(p.status === "ok", "a SLEEPING database is not degraded — the retry loop owns that copy", p);
}
{
  const p = statusFromProbe({ maintenanceFlagPresent: false, woke: false, diagnosis: null });
  ok(p.status === "ok", "a bare probe failure with no diagnosis fails open to ok", p);
}

// --------------------------------------------------------- client-side fold

ok(presentSigninSurface(null) === "signin", "an unreachable status endpoint fails open to the sign-in button");
ok(
  presentSigninSurface({ status: "ok" }) === "signin",
  "an ok station shows the sign-in button"
);
ok(
  presentSigninSurface({ status: "updating" }) === "updating",
  "an updating station never shows the button"
);
ok(
  presentSigninSurface({ status: "degraded", diagnosis: mismatch }) === "degraded",
  "a permanent failure degrades the surface"
);
ok(
  presentSigninSurface({ status: "degraded", diagnosis: sleeping }) === "signin",
  "but a sleeping diagnosis on the wire still fails open — the surface must not contradict the retry loop"
);
ok(
  presentSigninSurface({ status: "degraded", diagnosis: null }) === "signin",
  "and a degraded payload with no reason shows the button rather than nothing"
);

// The payload the route would actually send: nothing but a public-safe
// summary may ride along, whatever the raw error knew.
{
  const p: StationStatusPayload = statusFromProbe({ maintenanceFlagPresent: false, woke: false, diagnosis: mismatch });
  const wire = JSON.stringify(p);
  ok(!wire.includes("://"), "the wire payload carries no URL", wire);
  ok(!/db\.internal/i.test(wire), "and no hostname");
}

console.log(`  ${passed}/${passed + failed} station-status assertions passed`);
if (failed) process.exit(1);
