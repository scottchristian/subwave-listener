import prisma from "@/lib/prisma";
import { APP_VERSION, REPO, REPO_URL } from "@/lib/version";
import {
  parseChannel,
  decideUpdatePrompt,
  readSource,
  UPDATE_CHANNEL_KEY,
  type UpdateChannel,
} from "@/lib/update";
import { fetchBranchHead } from "@/lib/update-run";

// GitHub's unauthenticated rate limit is 60 requests an hour per IP, and a station
// sits behind a single address, so a naive poll would exhaust it and then report
// "no update" forever. One lookup per hour per channel, held in module scope so it
// is shared across requests and survives across them in a long-running process.
const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;

export type UpdateStatus = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  notes: string | null;
  checkedAt: string;
  /** The operator's chosen channel — callers default UI to this. */
  channel: UpdateChannel;
};

const unknownFor = (channel: UpdateChannel): Omit<UpdateStatus, "current" | "checkedAt"> => ({
  latest: null,
  updateAvailable: false,
  releaseUrl: channel === "release" ? REPO_URL + "/releases" : `${REPO_URL}/tree/${channel}`,
  notes: null,
  channel,
});

let cached: { at: number; channel: UpdateChannel; payload: UpdateStatus } | null = null;

/** The saved channel, defaulting to stable releases on any doubt. */
export async function readUpdateChannel(): Promise<UpdateChannel> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: UPDATE_CHANNEL_KEY } });
    if (row) return parseChannel(row.value);
  } catch {
    // database unreadable — release default stands
  }
  return "release";
}

/**
 * "Is there an update on the operator's channel?" Shared by the admin panel
 * (via the update-check route) and the automatic-update scheduler, so a human
 * and the timer can never disagree about what is available.
 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const channel = await readUpdateChannel();

  if (cached && cached.channel === channel && Date.now() - cached.at < CACHE_MS) {
    return cached.payload;
  }

  let payload: UpdateStatus;
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
      const [head, source] = await Promise.all([fetchBranchHead(channel), readSource()]);
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

  cached = { at: Date.now(), channel, payload };
  return payload;
}
