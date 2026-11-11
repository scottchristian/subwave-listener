import path from "node:path";

/**
 * Resolve a relative `file:` URL the way Prisma 5 did — against prisma/, where
 * the schema lives. Prisma 7's config file resolves against its own directory
 * and the sqlite driver adapter against the working directory, so both call
 * here to keep pointing at the station's actual database.
 *
 * Repo convention depends on it: `.env.local` says `file:../data/app.db` to
 * mean <app>/data/app.db (see README and docs/deployment.md).
 */
export function resolveDatabaseUrl(url: string | undefined, prismaDir: string): string | undefined {
  if (!url || !url.startsWith("file:")) return url;
  const rest = url.slice("file:".length);
  if (!rest || path.isAbsolute(rest)) return url;
  return `file:${path.resolve(prismaDir, rest)}`;
}
