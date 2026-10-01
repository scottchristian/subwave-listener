// Postgres permission probe.
//
// Answers one question: can this role actually run the station's database, and
// if not, exactly which grants are missing? Every error below was observed
// against PostgreSQL 16 while rehearsing from a stock role template:
//
//   CREATE ROLE x WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
//     INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
//
// so the mapping is evidence, not guesswork. The four grants this returns are
// each load-bearing: drop one and a specific capability fails.
import { Client } from "pg";
import { maskDatabaseUrl } from "./db-provider";

export type ProbeCheck = {
  name: string;
  ok: boolean;
  detail: string;
  /** SQL that fixes THIS check, when it is the missing link. */
  fix?: string;
};

export type ProbeResult = {
  ok: boolean;
  role: string | null;
  database: string | null;
  version: string | null;
  ssl: boolean;
  /** All checks pass — safe to run the copy. */
  ready: boolean;
  checks: ProbeCheck[];
  /** The single pasteable block, always returned so operators can compare. */
  sql: string;
  error?: string;
};

export function parseUrl(url: string): {
  user: string;
  database: string;
  host: string;
} | null {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username || "");
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!user || !database) return null;
    return { user, database, host: u.hostname };
  } catch {
    return null;
  }
}

/**
 * The one block.
 *
 * The last two statements act on a *schema*, which is per-database. An
 * operator who runs them while connected to the wrong database gets no error —
 * the grants simply land on another database's public schema and the station
 * still fails. Hence the instruction above them. `\c` is deliberately not used:
 * it is a psql meta-command and errors in most hosted SQL consoles.
 */
export function grantSql(role: string, database: string): string {
  return [
    `-- Promote ${role} to a station app role.`,
    `-- Run as a superuser, connected to the "${database}" database.`,
    `-- (the last two statements act on that database's schema)`,
    `ALTER ROLE ${role} LOGIN;`,
    `GRANT CONNECT ON DATABASE ${database} TO ${role};`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${role};`,
    `ALTER SCHEMA public OWNER TO ${role};`,
  ].join("\n");
}

// Identifiers are interpolated, so they must be plain. A role called
// `x"; DROP DATABASE production; --` must never reach the SQL string.
const identOk = (s: string) => /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(s);
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Hand every existing table to the app role.
 *
 * Owning the *schema* is not enough once a superuser has created the tables:
 * a table's owner is whoever ran CREATE TABLE, and ALTER/DROP are owner-only,
 * so the app role can still create new tables yet fail to migrate the real
 * ones. There is no single GRANT for this, hence the loop — but it is still
 * one pasteable statement.
 */
function adoptExistingTablesSql(role: string): string {
  const lit = `'${role.replace(/'/g, "''")}'`;
  return [
    `-- Hand the existing tables to ${role}. Only needed when an administrator`,
    `-- created the schema; the station creates its own tables otherwise.`,
    `DO $$`,
    `DECLARE t text;`,
    `BEGIN`,
    `  FOR t IN SELECT tablename FROM pg_tables`,
    `             WHERE schemaname = 'public' AND tableowner <> ${lit}`,
    `  LOOP`,
    `    EXECUTE format('ALTER TABLE %I OWNER TO %I', t, ${lit});`,
    `  END LOOP;`,
    `END $$;`,
  ].join("\n");
}

// A table the app role should own but does not. Lets us detect the ownership
// gap that table-level GRANTs cannot fix.
const PROBE_TABLE = "__subwave_perm_probe";

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e: any) {
    return { ok: false, code: String(e?.code || ""), message: String(e?.message || e) };
  }
}

export async function probePostgres(url: string): Promise<ProbeResult> {
  const parsed = parseUrl(url);
  if (!parsed) {
    return {
      ok: false, role: null, database: null, version: null, ssl: false, ready: false,
      checks: [], sql: "", error: "That does not look like a Postgres URL.",
    };
  }
  const { user: role, database } = parsed;
  const sql = grantSql(role, database);
  if (!identOk(role) || !identOk(database)) {
    return {
      ok: false, role, database, version: null, ssl: false, ready: false, checks: [], sql,
      error: "Role or database name contains characters that cannot be used in SQL. Rename it to letters, digits and underscores.",
    };
  }

  const client = new Client({
    connectionString: url,
    // Managed Postgres requires TLS; the URL's own sslmode decides. Never
    // force verify off — we would be silently trusting any cert.
    ssl: /sslmode=disable/i.test(url) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
    statement_timeout: 20000,
  });

  try {
    await client.connect();
  } catch (e: any) {
    const msg = String(e?.message || e);
    const code = String(e?.code || "");
    const checks: ProbeCheck[] = [];
    // The role cannot even authenticate. NOLOGIN and a bad password look
    // similar to the client, so distinguish on the server's wording.
    if (/not permitted/i.test(msg)) {
      checks.push({
        name: "login", ok: false,
        detail: `Role "${role}" exists but is not permitted to log in (NOLOGIN).`,
        fix: `ALTER ROLE ${role} LOGIN;`,
      });
    } else if (/password authentication failed/i.test(msg) || code === "28P01") {
      checks.push({
        name: "login", ok: false,
        detail: "Password rejected. Check the password, and that the host allows password auth from this machine.",
        fix: `ALTER ROLE ${role} WITH LOGIN PASSWORD 'your-password';`,
      });
    } else {
      checks.push({
        name: "login", ok: false,
        detail: `Cannot connect to ${maskDatabaseUrl(url)} — ${msg.split("\n")[0]}`,
      });
    }
    await client.end().catch(() => {});
    return {
      ok: false, role, database, version: null, ssl: false, ready: false,
      checks, sql, error: msg.split("\n")[0],
    };
  }

  const checks: ProbeCheck[] = [];
  let version: string | null = null;
  const q = async (text: string) => (await client.query(text)).rows;

  try {
    // 1. Who am I, and is this actually Postgres?
    const who = await attempt(() => q("SELECT current_user AS usr, current_database() AS db, version() AS v"));
    if (!who.ok) throw new Error(who.message);
    version = String(who.value[0].v).split(" ").slice(0, 2).join(" ");
    checks.push({
      name: "connect",
      ok: true,
      detail: `connected as ${who.value[0].usr} to ${who.value[0].db} (${version})`,
    });

    // 2. Schema CREATE — the PG 15+ public-schema wall.
    const create = await attempt(() => q(`CREATE TABLE ${quoteIdent(PROBE_TABLE)} (id text)`));
    if (create.ok) {
      checks.push({ name: "create tables", ok: true, detail: "can create tables in the public schema" });
    } else if (/permission denied for schema/i.test(create.message)) {
      checks.push({
        name: "create tables", ok: false,
        detail: `${create.message.split("\n")[0]} — PostgreSQL 15 and newer do not grant CREATE on the public schema by default.`,
        fix: `GRANT USAGE, CREATE ON SCHEMA public TO ${role};`,
      });
    } else {
      checks.push({
        name: "create tables", ok: false,
        detail: create.message.split("\n")[0],
        fix: `GRANT USAGE, CREATE ON SCHEMA public TO ${role};`,
      });
    }

    // 3. Write and read a table it owns. Passes as soon as CREATE succeeded,
    //    but worth proving: a role can create and still lack table grants on
    //    tables an admin created earlier.
    if (create.ok) {
      const write = await attempt(async () => {
        await q(`INSERT INTO ${quoteIdent(PROBE_TABLE)} (id) VALUES ('probe')`);
        const r = await q(`SELECT id FROM ${quoteIdent(PROBE_TABLE)}`);
        await q(`DELETE FROM ${quoteIdent(PROBE_TABLE)}`);
        return r;
      });
      checks.push({
        name: "read and write",
        ok: write.ok,
        detail: write.ok ? "can insert, select and delete rows" : write.message.split("\n")[0],
        ...(write.ok ? {} : { fix: `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};` }),
      });

      // 4. Ownership. This is the wall that table-level GRANTs cannot fix:
      //    ALTER and DROP are owner-only, and Prisma needs both to migrate.
      const owns = await attempt(() => q(
        `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ${literal(PROBE_TABLE)}`
      ));
      const owner = owns.ok ? String(owns.value[0]?.owner) : "";
      checks.push({
        name: "own tables",
        ok: owner === role,
        detail: owner === role
          ? `owns the tables it creates, so future migrations can run`
          : `tables are owned by ${owner || "someone else"} — a table-level GRANT does not allow ALTER or DROP`,
        ...(owner === role ? {} : { fix: `ALTER SCHEMA public OWNER TO ${role};` }),
      });

      await q(`DROP TABLE IF EXISTS ${quoteIdent(PROBE_TABLE)}`).catch(() => {});
    }

    // 5. Existing tables. A schema created by a superuser leaves the app role
    //    with no privileges on it at all, which looks fine until the first read.
    const existing = await attempt(() => q(
      `SELECT count(*)::int AS n FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> ${literal(PROBE_TABLE)}`
    ));
    if (existing.ok && existing.value[0].n > 0) {
      const target = await attempt(() => q(
        `SELECT c.relname AS t, pg_get_userbyid(c.relowner) AS owner,
                has_table_privilege(current_user, c.oid, 'SELECT') AS can_read
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname <> ${literal(PROBE_TABLE)}
         LIMIT 1`
      ));
      if (target.ok && target.value[0]) {
        const t = target.value[0];
        const ownsIt = String(t.owner) === role;
        checks.push({
          name: "existing tables",
          ok: Boolean(t.can_read) && ownsIt,
          detail: Boolean(t.can_read) && ownsIt
            ? `${existing.value[0].n} table(s) present, readable and owned by ${role}`
            : `${existing.value[0].n} table(s) already exist, owned by ${t.owner}. ` +
              (t.can_read
                ? "Readable, but not owned — migrations would fail on them."
                : "This role cannot read them. They were created by an administrator, so give it the schema and the tables."),
          ...(ownsIt ? {} : { fix: adoptExistingTablesSql(role) }),
        });
      }
    } else if (existing.ok) {
      checks.push({
        name: "existing tables",
        ok: true,
        detail: "database is empty — this role will create the schema itself",
      });
    }
  } finally {
    await client.end().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    role,
    database,
    version,
    ssl: true,
    ready: failed.length === 0,
    checks,
    sql,
  };
}

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
