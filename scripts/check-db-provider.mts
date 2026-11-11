// Database URL masking and provider detection.
//
// maskDatabaseUrl is the last thing between a database password and a browser
// or a log line, and it is called from places that are easy to forget. The
// failure mode is silent — a masked URL looks like a masked URL whether or not
// it still contains the secret — so it gets exercised against the shapes real
// providers hand out, including the ones that break a naive regex.
//
// providerFromEnv decides which engine is live and therefore which client is
// generated, so a wrong answer is a failed build or a migration against the
// wrong database.
//
// Pure functions, no database, no disk.
//
// Run: npm run check:db-provider
const dbp = await import("../lib/db-provider.ts");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

// ---- masking: the password never survives ----
const maskOf = (u: string | null | undefined): string => dbp.maskDatabaseUrl(u);
const leak = (u: string, needle: string): boolean => maskOf(u).includes(needle);

const PASSWORD = "hunter2-SUPERSECRET";
const cases: [string, string][] = [
  ["postgres", `postgresql://appuser:${PASSWORD}@db.example.com:5432/station`],
  ["postgres alias scheme", `postgres://appuser:${PASSWORD}@db.example.com/station`],
  ["password with url-encoded specials", `postgresql://appuser:${encodeURIComponent(PASSWORD)}@db.example.com/station`],
  ["password containing an at sign", `postgresql://appuser:${encodeURIComponent("a@b")}@db.example.com/station`],
  ["password containing a colon", `postgresql://appuser:${encodeURIComponent("a:b")}@db.example.com/station`],
  ["no username", `postgresql://:${PASSWORD}@db.example.com/station`],
];
for (const [label, url] of cases) {
  ok(!leak(url, PASSWORD), `${label}: password masked`);
  ok(!leak(url, encodeURIComponent(PASSWORD)), `${label}: encoded password masked`);
  ok(!maskOf(url).includes("hunter2"), `${label}: no fragment of the password leaks`);
}

// ---- masking: the rest of the URL stays diagnosable ----
const m = maskOf(`postgresql://appuser:${PASSWORD}@db.example.com:5432/station`);
ok(m.includes("appuser"), "the username survives (needed to debug grants)");
ok(m.includes("db.example.com"), "the host survives");
ok(m.includes("5432"), "the port survives");
ok(m.includes("station"), "the database name survives");
ok(!m.includes(PASSWORD), "and the password does not");

// ---- query strings are dropped wholesale: sslkey paths live there ----
for (const label of ["sslkey path", "password in query", "sslmode"]) {
  ok(!maskOf(`postgresql://u:p@h/db?sslkey=/etc/ssl/private/server.key`).includes("server.key"), `${label} is not exposed`);
}
ok(maskOf("postgresql://u:p@h/db?sslmode=require").includes("?"), "the query is still marked as present");
ok(!maskOf("postgresql://u:p@h/db?sslmode=require").includes("require"), "query values are not exposed");

// ---- SQLite paths are left completely alone: there is no secret in them ----
const sqlite = "file:/var/lib/station/data/causeway.db";
ok(maskOf(sqlite) === sqlite, "a sqlite path is returned untouched");
ok(maskOf("/var/lib/station/causeway.db") === "/var/lib/station/causeway.db", "a bare sqlite path is untouched");
ok(maskOf("") === "", "empty masks to empty");
ok(maskOf(null) === "", "null masks to empty");
ok(maskOf(undefined) === "", "undefined masks to empty");

// ---- provider detection: explicit setting wins, URL scheme is the fallback ----
ok(dbp.providerFromEnv("postgresql", "file:/x.db") === "postgresql", "explicit postgres beats a sqlite url");
ok(dbp.providerFromEnv("sqlite", "postgresql://u:p@h/db") === "sqlite", "explicit sqlite beats a postgres url");
ok(dbp.providerFromEnv("postgres", undefined) === "postgresql", "the postgres alias is accepted");
ok(dbp.providerFromEnv("  PostgreSQL  ", undefined) === "postgresql", "case and padding are tolerated");
ok(dbp.providerFromEnv(undefined, "postgresql://u:p@h/db") === "postgresql", "url scheme is read when unset");
ok(dbp.providerFromEnv("", "postgres://u:p@h/db") === "postgresql", "blank setting falls through to the url");
ok(dbp.providerFromEnv(undefined, "file:/x.db") === "sqlite", "file url means sqlite");
ok(dbp.providerFromEnv(undefined, undefined) === "sqlite", "nothing set means sqlite (pre-migration env files)");
ok(dbp.providerFromEnv(undefined, "") === "sqlite", "an empty url means sqlite");
ok(dbp.providerFromEnv(undefined, "nonsense") === "sqlite", "an unrecognised url falls back to sqlite");

// ---- otherProvider is the cutover direction and must be exact ----
ok(dbp.otherProvider("sqlite") === "postgresql", "sqlite cuts over to postgres");
ok(dbp.otherProvider("postgresql") === "sqlite", "postgres cuts back to sqlite");
for (const p of ["sqlite", "postgresql"] as const) {
  ok(dbp.otherProvider(dbp.otherProvider(p)) === p, `${p} round-trips through otherProvider`);
  ok(dbp.otherProvider(p) !== p, `${p} never maps to itself`);
}

console.log(`  ${passed}/${passed + failed} db-provider assertions passed`);
if (failed > 0) process.exit(1);
