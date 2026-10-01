import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { dec, displayEmail, displayName } from "@/lib/pii";

const DAY_MS = 86_400_000;
// An open session (no endTime) is only trusted while fresh: restarts, deploys
// and dead sockets orphan rows whose close hook never runs (140 open rows on
// a 4-user station, most aged 6-24h). Anything open longer than this counts 0;
// a genuinely-listening user has a fresh row, and their time lands when the
// socket closes and durationSec is written.
const LIVE_OPEN_MS = 1 * 3_600_000;
// Sanity cap per session so one bad row can't invent a month of listening.
const MAX_SESSION_SEC = 24 * 3_600;

// Two intervals separated by less than this are the same listening session.
//
// Browsers reconnect constantly — a dropped socket, a tab wake, a network blip,
// a Safari probe-double — and each one opens a fresh StreamSession row. Counting
// rows therefore reported thousands of "plays" for a station started a handful
// of times: one account had 5363 rows against 321 real intervals, of which 4928
// were stale orphans that contributed no time at all.
//
// Three minutes absorbs the reconnect noise (the median gap between that
// account's real intervals was 0s) while still splitting a genuine "I closed the
// tab and came back later". Ten minutes was the first guess and sat too high —
// it swallowed real breaks. Tunable in one place; on that same data 60s yields
// 73 sessions, 300s yields 52, 600s yielded 41.
const BUNDLE_GAP_MS = 3 * 60 * 1000;

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
    include: { user: { select: { name: true, nickname: true, email: true, emailEnc: true } } },
    orderBy: { startTime: "desc" },
  });
  // Seed from every account so approved users with zero plays still show.
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, email: true, emailEnc: true, nickname: true },
  });
  const likeGroups = await prisma.songLike.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  const likesByUser: Record<string, number> = {};
  for (const g of likeGroups) likesByUser[g.userId] = g._count._all;

  const byUser = new Map<
    string,
    { user: { name: string | null; nickname: string | null; email: string | null }; ivs: { s: number; e: number }[] }
  >();
  for (const u of allUsers) {
    byUser.set(u.id, {
      user: { name: displayName(u), nickname: dec(u.nickname), email: displayEmail(u) },
      ivs: [],
    });
  }

  for (const s of sessions) {
    if (!s.userId) continue;
    let e = byUser.get(s.userId);
    if (!e) {
      // Orphaned row: the user is gone, but the session still carries their
      // (encrypted) name/email — decrypt so the admin roster stays readable.
      const su = (s as any).user;
      e = {
        user: su
          ? { name: displayName(su), nickname: dec(su.nickname), email: displayEmail(su) }
          : { name: null, nickname: null, email: null },
        ivs: [],
      };
      byUser.set(s.userId, e);
    }
    // No row counter here. The play count is derived from the bundled intervals
    // below, so an orphaned row that contributes no time cannot inflate it.
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

  // Collapse each run of connected intervals into one session.
  //
  // This does two jobs at once. Overlapping rows — every Play press logs ~2
  // (Safari probe-double) — are counted once. And gaps under BUNDLE_GAP_MS are
  // closed over, so a listener whose socket bounced three times inside a minute
  // reads as one session whose duration spans first start to last end, instead
  // of three plays with three unrelated durations and the dead air between them
  // counted against nobody.
  const merge = (ivs: { s: number; e: number }[]) => {
    ivs.sort((a, b) => a.s - b.s);
    const out: { s: number; e: number }[] = [];
    for (const iv of ivs) {
      const m = out[out.length - 1];
      if (m && iv.s - m.e <= BUNDLE_GAP_MS) m.e = Math.max(m.e, iv.e);
      else out.push({ ...iv });
    }
    return out;
  };
  const overlapSec = (ivs: { s: number; e: number }[], w0: number, w1: number) => {
    let t = 0;
    for (const iv of ivs) t += Math.max(0, Math.min(iv.e, w1) - Math.max(iv.s, w0));
    return Math.floor(t / 1000);
  };
  // Sessions overlapping the window. Same overlap rule as the seconds, so the
  // two figures on the row always describe the same set of sessions.
  const overlapCount = (ivs: { s: number; e: number }[], w0: number, w1: number) =>
    ivs.reduce((n, iv) => n + (iv.s < w1 && iv.e > w0 ? 1 : 0), 0);

  const rows = [...byUser.entries()].map(([userId, e]) => {
    const merged = merge(e.ivs);
    const day0 = now - DAY_MS;
    const week0 = now - 7 * DAY_MS;
    const month0 = now - 30 * DAY_MS;
    return {
      userId,
      user: e.user,
      day: { sec: overlapSec(merged, day0, now), n: overlapCount(merged, day0, now) },
      week: { sec: overlapSec(merged, week0, now), n: overlapCount(merged, week0, now) },
      month: { sec: overlapSec(merged, month0, now), n: overlapCount(merged, month0, now) },
      all: { sec: overlapSec(merged, 0, now), n: merged.length },
      likes: likesByUser[userId] ?? 0,
    };
  });
  rows.sort((a, b) => b.all.sec - a.all.sec);
  return NextResponse.json(rows);
}
