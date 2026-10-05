import prisma from "@/lib/prisma";

/**
 * Session + approval answers without the database, for hot routes.
 *
 * The proxy already caches the gate for 60s, but every route then calls
 * getServerSession itself — another session read plus the approval lookup,
 * per request. On a 15s heartbeat that is ~3 reads a minute per open tab for
 * an answer that barely changes. So: one entry per token, session validity
 * trusted 60s, approval/admin/display fields trusted 5 minutes. Revocation
 * lands within a minute (same trade the proxy already makes); approval
 * changes within five. Admin-only routes keep calling getServerSession
 * directly — privilege changes there take effect immediately.
 *
 * SERVER-ONLY (prisma + memory maps): never import from a client component.
 * `load`/`now` are injectable so the TTL logic tests without a database.
 */

export type CachedSession = {
  userId: string;
  sessionExpires: number;
  isApproved: boolean;
  isAdmin: boolean;
  name: string | null;
  nickname: string | null;
  email: string | null;
  emailEnc: string | null;
};

const SESSION_TTL_MS = 60_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 5_000;
const MAX_ENTRIES = 1000;

type Entry = { at: number; approvalAt: number; value: CachedSession | null };
const cache = new Map<string, Entry>();

export function clearSessionCache(): void {
  cache.clear();
}

async function defaultLoad(token: string): Promise<CachedSession | null> {
  const session = await prisma.session.findUnique({
    where: { sessionToken: token },
    select: { expires: true, userId: true },
  });
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      name: true,
      nickname: true,
      email: true,
      emailEnc: true,
      isApproved: true,
      isAdmin: true,
    },
  });
  if (!user) return null;
  return {
    userId: user.id,
    sessionExpires: session.expires.getTime(),
    isApproved: user.isApproved ?? false,
    isAdmin: user.isAdmin ?? false,
    name: user.name ?? null,
    nickname: user.nickname ?? null,
    email: user.email ?? null,
    emailEnc: user.emailEnc ?? null,
  };
}

export async function cachedSession(
  token: string | undefined,
  opts?: { now?: number; load?: (token: string) => Promise<CachedSession | null> }
): Promise<CachedSession | null> {
  if (!token) return null;
  const now = opts?.now ?? Date.now();
  const load = opts?.load ?? defaultLoad;
  const hit = cache.get(token);
  if (hit) {
    const sessionFresh = now - hit.at < SESSION_TTL_MS;
    const approvalFresh = now - hit.approvalAt < APPROVAL_TTL_MS;
    if (hit.value && sessionFresh && approvalFresh) return hit.value;
    if (!hit.value && now - hit.at < NEGATIVE_TTL_MS) return null;
    // Half-stale: session valid but approval aged out — refresh approval
    // only, keeping the entry (and its session verdict) on a miss.
    if (hit.value && sessionFresh && !approvalFresh) {
      try {
        const fresh = await load(token);
        if (fresh) {
          cache.set(token, { at: hit.at, approvalAt: now, value: fresh });
          return fresh;
        }
      } catch {
        return hit.value;
      }
    }
  }
  let value: CachedSession | null = null;
  try {
    value = await load(token);
  } catch {
    return hit?.value ?? null;
  }
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(token, { at: now, approvalAt: now, value });
  if (value && value.sessionExpires <= now) return null;
  return value;
}

/** Drop one token — call after anything that mutates sessions or approval. */
export function dropSessionCache(token: string): void {
  cache.delete(token);
}

const COOKIE_NAMES = ["__Secure-next-auth.session-token", "next-auth.session-token"];

/** Pull the session token out of request cookies (any route runtime shape). */
export function sessionTokenFromCookies(req: {
  cookies: { get(name: string): { value?: string } | undefined };
}): string | undefined {
  for (const name of COOKIE_NAMES) {
    const v = req.cookies.get(name)?.value;
    if (v) return v;
  }
  return undefined;
}
