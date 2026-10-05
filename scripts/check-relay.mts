// Relay host parsing and the Postgres grant block.
//
// Two separate risks in one place because both end up as text another program
// executes: backendFromApiUrl feeds <server>/<port> in icecast.xml, and
// grantSql is a block an operator pastes into a superuser console. The first
// silently breaks the stream if it hands Icecast a bracketed IPv6 literal (the
// failure is "Failed to connect", long after the save). The second is an
// injection point if an identifier is interpolated unchecked.
//
// Run: npm run check:relay
const relay = await import("../lib/relay.ts");
const probe = await import("../lib/pg-probe.ts");

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
function throws(fn: () => unknown, name: string) {
  try {
    fn();
    ok(false, name, "did not throw");
  } catch {
    ok(true, name);
  }
}

// ---- the API URL becomes a host and port ----
{
  const r = relay.backendFromApiUrl("http://radio.example.com:7700/api");
  ok(r.server === "radio.example.com" && r.port === 7700, "host and explicit port");
  ok(relay.backendFromApiUrl("https://radio.example.com:8000/api").port === 8000, "https with an explicit port");
  ok(relay.backendFromApiUrl("http://radio.example.com/api").port === 7700, "a missing port defaults to 7700");
  ok(relay.backendFromApiUrl("https://radio.example.com/api").server === "radio.example.com", "hostname has no port suffix");
}
// An operator pasting a LAN address must work; so must a bracketed IPv6 paste,
// which has to be stripped or Icecast refuses to connect.
{
  const v6 = relay.backendFromApiUrl("http://[2001:db8::1]:7700/api");
  ok(v6.server === "2001:db8::1", "bracketed IPv6 is unwrapped for <server>");
  ok(!v6.server.startsWith("["), "the brackets are gone, or the relay cannot connect");
  ok(v6.port === 7700, "the IPv6 port is read");
}
for (const bad of ["ftp://radio.example.com:7700/api", "file:///etc/passwd", "ws://radio.example.com:7700/api"]) {
  throws(() => relay.backendFromApiUrl(bad), `refused non-http scheme: ${bad.split(":")[0]}`);
}
throws(() => relay.backendFromApiUrl("not a url at all"), "refused a non-URL");
throws(() => relay.backendFromApiUrl(""), "refused an empty address");

// ---- the grant block: identifiers are interpolated, so they must be plain ----
{
  const sql = probe.grantSql("station_app", "station_db");
  ok(sql.includes("ALTER ROLE station_app LOGIN;"), "the role is granted login");
  ok(sql.includes('GRANT CONNECT ON DATABASE station_db TO station_app;'), "connect is granted");
  ok(sql.includes("GRANT USAGE, CREATE ON SCHEMA public TO station_app;"), "schema usage is granted");
  ok(/ALTER SCHEMA public OWNER TO station_app;/.test(sql), "the schema is handed over");
  ok(sql.includes('"station_db"'), "the target database is named in the instruction above the schema statements");
  ok(!/\\c\s/.test(sql), "no psql meta-command, which errors in hosted consoles");
}
// Identifiers are interpolated into a block the operator pastes into a
// superuser console, so a hostile name must yield NO block at all — the panel
// renders whatever comes back under "Run this as a database administrator".
for (const evil of [
  'x"; DROP DATABASE production; --',
  "x'; DROP DATABASE production; --",
  "role; --",
  "a b",
  "with\ttab",
  "",
  "x".repeat(64),
]) {
  const sql = probe.grantSql(evil, "station_db");
  ok(sql === "", `no block is offered for a hostile role: ${JSON.stringify(evil.slice(0, 24))}`);
  ok(probe.grantSql("station_app", evil) === "", `no block is offered for a hostile database: ${JSON.stringify(evil.slice(0, 24))}`);
}
// Both halves must be plain, and the boundary is inclusive at 63 characters.
ok(probe.grantSql("a".repeat(63), "station_db") !== "", "a 63-character role is still plain enough");
ok(probe.grantSql("station_app", "db".repeat(1)) !== "", "a plain database name is accepted");
ok(probe.grantSql("role-with-dash", "db_1") !== "", "dashes and underscores are allowed in identifiers");

// ---- parseUrl feeds the block, so a bad paste must be reported, not guessed ----
{
  const p = probe.parseUrl("postgresql://station_app:SECRET@db.example.com:5432/station_db");
  ok(p?.user === "station_app", "the user is read");
  ok(p?.database === "station_db", "the database is read");
  ok(p?.host === "db.example.com", "the host is read");
  // The password must never be part of the parse result — it is not needed to
  // build the grant, and this object can end up in a log or an API response.
  ok(!JSON.stringify(p).includes("SECRET"), "the password is not carried in the parse result");
}
{
  const p = probe.parseUrl("postgresql://user%40corp:pw@db.example.com:5432/station%20db");
  ok(p?.user === "user@corp", "a percent-encoded username decodes");
  ok(p?.database === "station db", "a percent-encoded database name decodes");
}
ok(probe.parseUrl("postgresql://db.example.com/station_db") === null, "a url with no user is refused");
ok(probe.parseUrl("postgresql://user@db.example.com/") === null, "a url with no database is refused");
ok(probe.parseUrl("nonsense") === null, "a non-URL is refused");
ok(probe.parseUrl("") === null, "an empty string is refused");

console.log(`  ${passed}/${passed + failed} relay assertions passed`);
if (failed > 0) process.exit(1);
