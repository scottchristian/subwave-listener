// Which database engine is live. One engine at a time: this is a migration
// back and forth, never a dual-write.
//
// DB_PROVIDER is the source of truth and is written to .env.local at cutover
// time, next to DATABASE_URL. When it is absent we fall back to sniffing the
// URL scheme, and finally to SQLite, so an env file that predates the
// migration keeps working untouched.
export type DbProvider = "sqlite" | "postgresql";

export function providerFromEnv(
  provider: string | undefined = process.env.DB_PROVIDER,
  url: string | undefined = process.env.DATABASE_URL
): DbProvider {
  const p = (provider || "").trim().toLowerCase();
  if (p === "postgresql" || p === "postgres") return "postgresql";
  if (p === "sqlite") return "sqlite";
  const scheme = (url || "").trim().split(":")[0].toLowerCase();
  if (scheme === "postgresql" || scheme === "postgres") return "postgresql";
  return "sqlite";
}

export const otherProvider = (p: DbProvider): DbProvider =>
  p === "sqlite" ? "postgresql" : "sqlite";

/**
 * Mask a database URL for display. Postgres URLs carry the password inline, so
 * anything shown to a browser or written to a log goes through here first.
 * Also strips query parameters, which is where sslmode/key material hides.
 */
export function maskDatabaseUrl(url: string | null | undefined): string {
  if (!url) return "";
  let out = url;
  // userinfo: scheme://user:secret@host -> scheme://user:***@host
  // The username group is * — every shape with userinfo and a colon masks.
  // Requiring a username here leaked the password on `postgresql://:secret@host`
  // (empty username, which providers do hand out), because the regex never
  // matched and the URL was returned verbatim.
  out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*):([^@]*)@/i, "$1$2:***@");
  // Drop the query string entirely — it can carry sslkey paths and passwords.
  out = out.replace(/\?.*$/, "?***");
  return out;
}
