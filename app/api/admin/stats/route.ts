import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

const DAY_MS = 86_400_000;
// An open session (no endTime) is only trusted while fresh: restarts, deploys
// and dead sockets orphan rows whose close hook never runs (140 open rows on
// a 4-user station, most aged 6-24h). Anything open longer than this counts 0;
// a genuinely-listening user has a fresh row, and their time lands when the
// socket closes and durationSec is written.
const LIVE_OPEN_MS = 1 * 3_600_000;
// Sanity cap per session so one bad row can't invent a month of listening.
const MAX_SESSION_SEC = 24 * 3_600;

// Per-user listening time in rolling windows + current like count.
// Windows key off session startTime. Closed sessions use durationSec; an open
// session counts elapsed only while fresh (see LIVE_OPEN_MS).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = Date.now();
  const sessions = await prisma.streamSession.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { startTime: "desc" },
  });
  // Seed from every account so approved users with zero plays still show.
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, email: true, nickname: true },
  });
  const likeGroups = await prisma.songLike.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  const likesByUser: Record<string, number> = {};
  for (const g of likeGroups) likesByUser[g.userId] = g._count._all;

  const byUser = new Map<
    string,
    { user: { name: string | null; nickname: string | null; email: string | null }; ivs: { s: number; e: number }[]; n: number }
  >();
  for (const u of allUsers) {
    byUser.set(u.id, {
      user: { name: u.nickname || u.name, nickname: u.nickname, email: u.email },
      ivs: [],
      n: 0,
    });
  }

  for (const s of sessions) {
    if (!s.userId) continue;
    let e = byUser.get(s.userId);
    if (!e) {
      e = { user: (s as any).user ?? { name: null, nickname: null, email: null }, ivs: [], n: 0 };
      byUser.set(s.userId, e);
    }
    e.n += 1;
    // One interval per row: closed rows use durationSec, fresh open rows run
    // to now, stale open rows contribute nothing. Clipped to 24h each.
    const start = new Date(s.startTime).getTime();
    let end: number | null = null;
    if (typeof s.durationSec === "number") {
      end = start + Math.min(Math.max(s.durationSec, 0), MAX_SESSION_SEC) * 1000;
    } else if (!s.endTime && now - start <= LIVE_OPEN_MS) {
      end = now;
    }
    if (end == null || end <= start) continue;
    e.ivs.push({ s: start, e: Math.min(end, start + MAX_SESSION_SEC * 1000) });
  }

  // Merge overlapping intervals: every Play press logs ~2 rows (Safari
  // probe-double), and both stay open till Stop — naive sums count one
  // listen twice (or 14× across an hour of testing). Union counts it once.
  const merge = (ivs: { s: number; e: number }[]) => {
    ivs.sort((a, b) => a.s - b.s);
    const out: { s: number; e: number }[] = [];
    for (const iv of ivs) {
      const m = out[out.length - 1];
      if (m && iv.s <= m.e) m.e = Math.max(m.e, iv.e);
      else out.push({ ...iv });
    }
    return out;
  };
  const overlapSec = (ivs: { s: number; e: number }[], w0: number, w1: number) => {
    let t = 0;
    for (const iv of ivs) t += Math.max(0, Math.min(iv.e, w1) - Math.max(iv.s, w0));
    return Math.floor(t / 1000);
  };

  const rows = [...byUser.entries()].map(([userId, e]) => {
    const merged = merge(e.ivs);
    const day0 = now - DAY_MS;
    const week0 = now - 7 * DAY_MS;
    const month0 = now - 30 * DAY_MS;
    return {
      userId,
      user: e.user,
      day: { sec: overlapSec(merged, day0, now), n: e.n },
      week: { sec: overlapSec(merged, week0, now), n: e.n },
      month: { sec: overlapSec(merged, month0, now), n: e.n },
      all: { sec: overlapSec(merged, 0, now), n: e.n },
      likes: likesByUser[userId] ?? 0,
    };
  });
  rows.sort((a, b) => b.all.sec - a.all.sec);
  return NextResponse.json(rows);
}
