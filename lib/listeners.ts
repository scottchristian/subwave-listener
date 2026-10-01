// Active listener names, for the cutover gate.
//
// A migration rebuilds the Prisma client and restarts the app. Anyone mid-song
// would drop off, so the operator has to shut the station down in subwave
// first — the gate names them so it is obvious who is about to be cut off.

const STREAMING_MS = 10 * 60 * 1000;

export type Listener = {
  userId: string;
  name: string;
  since: string;
};

export async function activeListeners(): Promise<Listener[]> {
  const { default: prisma } = await import("./prisma");
  const { displayName } = await import("./pii");
  const now = new Date();
  const open = await prisma.streamSession.findMany({
    where: { endTime: null, startTime: { gte: new Date(now.getTime() - STREAMING_MS) } },
    include: { user: { select: { id: true, name: true, nickname: true } } },
    orderBy: { startTime: "asc" },
  });
  // Safari opens a second row per Play press, so dedupe by user.
  const seen = new Set<string>();
  const out: Listener[] = [];
  for (const s of open) {
    if (seen.has(s.userId)) continue;
    seen.add(s.userId);
    out.push({
      userId: s.userId,
      name: displayName(s.user) || "unnamed listener",
      since: s.startTime.toISOString(),
    });
  }
  return out;
}
