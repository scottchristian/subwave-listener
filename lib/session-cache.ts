import prisma from "@/lib/prisma";

/**
 * Session + approval answers without touching Postgres on most requests.
 *
 * Three tiers, cheapest first:
 *
 *   1. memory — this runtime only, ~60s. Next runs the proxy, route handlers
 *      and server components as separate module graphs, each with its own Map,
 *      so this alone is multiplied by the number of runtimes a request touches.
 *   2. SQLite — one file on disk, shared by every runtime on the host, valid
 *      for the operator's revalidation interval (20 minutes by default). This
 *      is the tier that actually removes the recurring session read.
 *   3. Postgres — the real database. Consulted whenever the tiers above miss,
 *      and the only thing that makes the station's answers true.
 *
 * SQLite is a cache and nothing more. Every call into it swallows its own
 * errors and reports a miss, so a deleted, corrupt or unwritable file costs one
 * revalidation and never a request. Deleting the file is a supported operation,
 * not an outage.
 *
 * Both cache tiers are bounded by the session's own expiry, so neither can
 * report a session as live that Postgres would reject. Admin-only routes keep
 * calling getServerSession directly, so a privilege change always lands
 * immediately and no cache can hand back stale admin rights.
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
  // Memory missed. The shared SQLite tier is next — this is the read that
  // removes the per-runtime session lookup, because every runtime on the host
  // sees the same file. Reached only on a memory miss, so it costs one local
  // disk hit per runtime per TTL rather than one per request.
  if (!opts?.load) {
    const fromDisk = await cachedSessionFromDisk(token, now);
    if (fromDisk) {
      remember(token, fromDisk, now);
      return fromDisk;
    }
  }

  let value: CachedSession | null = null;
  try {
    value = await load(token);
  } catch {
    return hit?.value ?? null;
  }
  remember(token, value, now);
  if (value && value.sessionExpires <= now) return null;
  // Write through, so the next runtime to see this token does not have to ask
  // Postgres either. Fire-and-forget: the answer is already in hand.
  if (value && value.sessionExpires > now) void writeSessionToDisk(token, value);
  return value;
}

function remember(token: string, value: CachedSession | null, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(token, { at: now, approvalAt: now, value });
}

/** The SQLite tier. Any failure is a miss — the caller then asks Postgres. */
async function cachedSessionFromDisk(token: string, now: number): Promise<CachedSession | null> {
  try {
    const lite = await import("@/lib/lite-cache");
    if (!(await lite.liteEnabled())) return null;
    const hash = await lite.sessionTokenHash(token);
    // No hash means no key configured. Caching sessions would then put live
    // tokens on disk, so the tier is skipped rather than made unsafe.
    if (!hash) return null;
    const row = await lite.liteGetSession(hash, now);
    if (!row) return null;
    return {
      userId: row.userId,
      sessionExpires: row.sessionExpires,
      isApproved: row.isApproved,
      isAdmin: row.isAdmin,
      name: row.name,
      nickname: row.nickname,
      email: row.email,
      emailEnc: row.emailEnc,
    };
  } catch {
    return null;
  }
}

/** Best-effort write-through. A cache that cannot be written is not an error. */
async function writeSessionToDisk(token: string, value: CachedSession): Promise<void> {
  try {
    const lite = await import("@/lib/lite-cache");
    if (!(await lite.liteEnabled())) return;
    const hash = await lite.sessionTokenHash(token);
    if (!hash) return;
    await lite.litePutSession(hash, value);
  } catch {
    // Nothing to do: the answer was already served from Postgres.
  }
}

/**
 * Drop one token — call after anything that mutates sessions or approval.
 *
 * Both tiers, always. Dropping only the memory map would leave the SQLite row
 * still serving a verdict the operator has already revoked, which is precisely
 * the thing the cache must never do.
 */
export function dropSessionCache(token: string): void {
  cache.delete(token);
  void (async () => {
    try {
      const lite = await import("@/lib/lite-cache");
      const hash = await lite.sessionTokenHash(token);
      if (hash) await lite.liteDropSession(hash);
    } catch {
      // A cache that cannot be dropped is stale at worst until its interval
      // expires. The memory entry — what this runtime actually serves — is gone.
    }
  })();
}

/** Drop every cached verdict for a user — approval or a privilege changed. */
export function dropSessionsForUser(userId: string): void {
  for (const [token, entry] of cache) {
    if (entry.value?.userId === userId) cache.delete(token);
  }
  void (async () => {
    try {
      const lite = await import("@/lib/lite-cache");
      await lite.liteDropSessionsForUser(userId);
    } catch {
      // Same trade as above.
    }
  })();
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
