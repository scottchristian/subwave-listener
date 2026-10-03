import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { APP_VERSION, REPO, REPO_URL } from "@/lib/version";
import {
  parseChannel,
  decideUpdatePrompt,
  readSource,
  UPDATE_CHANNEL_KEY,
  type UpdateChannel,
} from "@/lib/update";
import { fetchBranchHead } from "@/lib/update-run";
import prisma from "@/lib/prisma";

/**
 * "Is there a newer release?" for the admin panel.
 *
 * Deliberately does NOT update anything. This app is deployed by an rsync plus a
 * `next build` on the station's own server, and that rebuild restarts the process
 * a listener is streaming from. The on-air gatekeeper in deploy.sh exists precisely
 * because a rebuild during a broadcast is a bad thing to do by accident; letting a
 * button in a web panel trigger one would put that decision behind an auth cookie
 * instead of in front of an operator. So this only reports what is available and
 * links to it — updating stays a deliberate act by someone who can see the room is
 * empty.
 *
 * Auth: admin only. It reveals nothing sensitive (a public repo's version), but it
 * is operator information and there is no reason to serve it to listeners.
 */

// GitHub's unauthenticated rate limit is 60 requests an hour per IP, and a station
// sits behind a single address, so a naive poll would exhaust it and then report
// "no update" forever. One lookup per hour, held in module scope so it is shared
// across requests and survives across them in a long-running server process.
const CACHE_MS = 60 * 60 * 1000;
let cached: { at: number; payload: UpdatePayload } | null = null;
let cachedChannel: UpdateChannel | null = null;

// A hung request must not hang the panel. GitHub is normally fast, but a station
// on a bad link would otherwise leave this fetch pending until the client gives up.
const TIMEOUT_MS = 8_000;

type UpdatePayload = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  notes: string | null;
  checkedAt: string;
  /** The operator's chosen channel — the panel defaults its radio to this. */
  channel: UpdateChannel;
};

const unknownFor = (channel: UpdateChannel): Omit<UpdatePayload, "current" | "checkedAt"> => ({
  latest: null,
  updateAvailable: false,
  releaseUrl: channel === "release" ? REPO_URL + "/releases" : `${REPO_URL}/tree/${channel}`,
  notes: null,
  channel,
});

export async function GET() {
  // Checked before the cache so a listener cannot use this to probe the panel.
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return new Response("Forbidden", { status: 403 });
  }

  let channel: UpdateChannel = "release";
  try {
    const row = await prisma.setting.findUnique({ where: { key: UPDATE_CHANNEL_KEY } });
    if (row) channel = parseChannel(row.value);
  } catch {
    // database unreadable — release default stands
  }

  // Served from cache without touching the network — this is the path that runs
  // every time the admin page loads. Per-channel: switching channels refetches
  // rather than serving the other channel's answer.
  if (cached && cachedChannel === channel && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json(cached.payload, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  }

  let payload: UpdatePayload;
  try {
    if (channel === "release") {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          // GitHub rejects API requests without a User-Agent.
          "User-Agent": `${REPO} update check`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });

      if (!res.ok) throw new Error(`GitHub responded ${res.status}`);

      const rel = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
        draft?: boolean;
        prerelease?: boolean;
      };

      // `releases/latest` already excludes drafts and prereleases, but this is the
      // one endpoint where guessing wrong nags an operator, so check rather than trust.
      if (rel.draft || rel.prerelease || !rel.tag_name) throw new Error("no usable release");

      const prompt = decideUpdatePrompt({
        channel,
        source: null,
        headSha: null,
        latestRelease: rel.tag_name.replace(/^v/, ""),
        current: APP_VERSION,
      });
      payload = {
        current: APP_VERSION,
        latest: prompt.label,
        updateAvailable: prompt.available,
        releaseUrl: rel.html_url || REPO_URL + "/releases",
        notes: rel.body ? rel.body.slice(0, 2000) : null,
        checkedAt: new Date().toISOString(),
        channel,
      };
    } else {
      // Branch channel: compare the tip against what is installed. No source
      // record means never updated in-app — prompt, because installing writes
      // the record that silences the next check.
      const [head, source] = await Promise.all([
        fetchBranchHead(channel),
        readSource(),
      ]);
      const prompt = decideUpdatePrompt({
        channel,
        source,
        headSha: head.sha,
        latestRelease: null,
        current: APP_VERSION,
      });
      payload = {
        current: APP_VERSION,
        latest: prompt.label,
        updateAvailable: prompt.available,
        releaseUrl: `${REPO_URL}/tree/${channel}`,
        notes: null,
        checkedAt: new Date().toISOString(),
        channel,
      };
    }
  } catch {
    // No network, rate limited, no release yet — all the same to the operator:
    // no update prompt. Never surface the failure as "an update exists", and never
    // surface it as an error either; a station offline from GitHub is normal.
    payload = { ...unknownFor(channel), current: APP_VERSION, checkedAt: new Date().toISOString() };
  }

  cached = { at: Date.now(), payload };
  cachedChannel = channel;
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
