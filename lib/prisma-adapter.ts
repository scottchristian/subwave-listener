import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { providerFromEnv, type DbProvider } from "./db-provider";
import { resolveDatabaseUrl } from "./database-url";

/**
 * The driver adapter Prisma 7 requires. Provider comes from DB_PROVIDER when it
 * is set (the cutover can pass a URL for the other engine), otherwise from the
 * URL scheme — the same rule lib/db-provider.ts uses everywhere else.
 */
export function prismaAdapter(url: string | undefined, provider: DbProvider = providerFromEnv(undefined, url)) {
  const resolved = resolveDatabaseUrl(url, path.join(process.cwd(), "prisma"));
  if (provider === "postgresql") return new PrismaPg({ connectionString: resolved });
  return new PrismaBetterSqlite3({ url: resolved });
}
