import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

// Prove the Sub/Wave Server card values work end to end. Four checks:
// 1. backend reachable (public now-playing),
// 2. admin credentials accepted (admin settings read),
// 3. station password accepted (controller station-auth gate — the same
//    password Icecast checks per listener through /listener-auth; a drift
//    here kills audio while metadata keeps flowing),
// 4. relay serves audio (Range probe with ?auth= — exercises relay process,
//    relay→master auth, and controller listener-auth in one shot).
// Read-only — changes nothing on either side. Check 4 pulls a few KB.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) {
    return NextResponse.json({ error: "Server address not set" }, { status: 400 });
  }
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    // 1. Backend reachable.
    const np = await fetch(`${cfg.apiUrl}/now-playing`, { signal: AbortSignal.timeout(15000) });
    if (!np.ok) {
      return NextResponse.json(
        { error: `Backend answered ${np.status} — check server address` },
        { status: 502 }
      );
    }
    const data = await np.json().catch(() => ({}));
    const track = data?.nowPlaying?.title
      ? `${data.nowPlaying.title} — ${data.nowPlaying.artist || "unknown"}`
      : "nothing reported";
    const listeners = data?.listeners?.current;
    checks.push({ name: "backend", ok: true, detail: `on air: ${track}` });

    // 2. Admin credentials.
    const auth = subwaveAdminAuth(cfg);
    if (!auth) {
      checks.push({ name: "admin", ok: false, detail: "username/password not set — skip and never-play will fail" });
    } else {
      const st = await fetch(`${cfg.apiUrl}/settings`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(15000),
      });
      if (st.status === 401 || st.status === 403) {
        return NextResponse.json(
          { error: "Backend reachable, but username/password rejected", track, listeners: typeof listeners === "number" ? listeners : null, checks },
          { status: 502 }
        );
      }
      if (!st.ok) {
        return NextResponse.json(
          { error: `Backend reachable, admin check answered ${st.status}`, checks },
          { status: 502 }
        );
      }
      checks.push({ name: "admin", ok: true, detail: "credentials accepted" });
    }

    // 3. Station password (controller gate — same value Icecast verifies).
    if (!cfg.stationPassword) {
      checks.push({ name: "station-password", ok: false, detail: "not set — relay and direct streams need it" });
    } else {
      try {
        const sa = await fetch(`${cfg.apiUrl}/station-auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: cfg.stationPassword }),
          signal: AbortSignal.timeout(15000),
        });
        const sad = await sa.json().catch(() => ({}));
        if (sa.ok && sad?.ok) {
          checks.push({ name: "station-password", ok: true, detail: "accepted by backend" });
        } else if (sa.status === 429) {
          checks.push({ name: "station-password", ok: true, detail: "rate-limited, inconclusive — retry in a minute" });
        } else {
          return NextResponse.json(
            { error: "Station password rejected by backend — audio will fail while metadata works. Restore it (DEPLOY.md → Troubleshooting)", track, listeners: typeof listeners === "number" ? listeners : null, checks },
            { status: 502 }
          );
        }
      } catch {
        checks.push({ name: "station-password", ok: false, detail: "gate unreachable — continuing to relay probe" });
      }
    }

    // 4. Relay serves audio end to end.
    if (!cfg.streamUrl) {
      checks.push({ name: "relay", ok: false, detail: "relay stream URL not set (Admin → Sub/Wave Server)" });
    } else if (!cfg.stationPassword) {
      checks.push({ name: "relay", ok: false, detail: "skipped — station password missing" });
    } else {
      try {
        const target = new URL(cfg.streamUrl);
        target.searchParams.set("auth", cfg.stationPassword);
        const up = await fetch(target.toString(), {
          headers: { Range: "bytes=0-4095" },
          signal: AbortSignal.timeout(45000),
        });
        await up.body?.cancel().catch(() => {});
        const ct = up.headers.get("content-type") || "";
        if ((up.status === 200 || up.status === 206) && /audio/i.test(ct)) {
          checks.push({ name: "relay", ok: true, detail: `audio flowing (${up.status})` });
        } else if (up.status === 401 || up.status === 403) {
          return NextResponse.json(
            { error: "Relay rejected the station password — audio dead. Restore it (DEPLOY.md → Troubleshooting)", track, listeners: typeof listeners === "number" ? listeners : null, checks },
            { status: 502 }
          );
        } else if (up.status === 404) {
          // Mount absent: relay has no upstream source. Benign when the
          // station is asleep (nothing airing), fatal otherwise.
          let idle: boolean | null = null;
          try {
            const st8 = await fetch(`${cfg.apiUrl}/state`, { signal: AbortSignal.timeout(10000) });
            const sd = await st8.json().catch(() => ({}));
            if (typeof sd?.streamIdle === "boolean") idle = sd.streamIdle;
          } catch {}
          if (idle === true) {
            checks.push({ name: "relay", ok: true, detail: "station asleep — mount absent until first play (press play to wake)" });
          } else {
            return NextResponse.json(
              { error: "Relay has no stream mount and station is not asleep — check relay→backend link (DEPLOY.md → Troubleshooting)", track, listeners: typeof listeners === "number" ? listeners : null, checks },
              { status: 502 }
            );
          }
        } else {
          return NextResponse.json(
            { error: `Relay answered ${up.status} — check relay process and link (DEPLOY.md → Troubleshooting)`, track, listeners: typeof listeners === "number" ? listeners : null, checks },
            { status: 502 }
          );
        }
      } catch (e) {
        return NextResponse.json(
          { error: `Relay unreachable (${(e as Error)?.name === "TimeoutError" ? "timeout" : "network error"}) — is icecast2 running on the VPS?`, track, listeners: typeof listeners === "number" ? listeners : null, checks },
          { status: 502 }
        );
      }
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      return NextResponse.json({
        ok: true,
        track,
        listeners: typeof listeners === "number" ? listeners : null,
        warning: failed.map((c) => `${c.name}: ${c.detail}`).join(" · "),
        checks,
      });
    }
    return NextResponse.json({
      ok: true,
      track,
      listeners: typeof listeners === "number" ? listeners : null,
      checks,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Cannot reach backend (${(e as Error).message || "network error"}) — check server address` },
      { status: 502 }
    );
  }
}
