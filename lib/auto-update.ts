import prisma from "@/lib/prisma";
import { getSubwaveConfig } from "@/lib/subwave";
import {
  readJob,
  writeJob,
  jobRunning,
  readSource,
  isSameSource,
  shouldNotifyForRef,
  notifiedRefFor,
  UPDATE_NOTIFIED_KEY,
  type UpdateJob,
  type UpdateChannel,
} from "@/lib/update";
import { parseTimeOfDay, isInWindow, minutesInZone, toMinutes } from "./update-time";
import { pushToAdmins } from "@/lib/push";
import { getUpdateStatus } from "@/lib/update-check";
import { fetchRelease, fetchBranchHead, listenerCount, runUpdatePipeline, type UpdatePlan } from "@/lib/update-run";
import { APP_VERSION } from "@/lib/version";

/**
 * Automatic updates inside a nightly quiet window.
 *
 * The operator picks a time window (station time) and the station updates
 * itself the first minute it finds three things true at once: the window is
 * open, an update is available on their channel, and nobody is listening.
 * There is no "update anyway" override here — unlike the manual button, there
 * is no human watching, so a non-empty or unreadable room means skip the tick
 * and try again in a minute.
 */

export const AUTO_UPDATE_KEYS = {
  enabled: "autoUpdateEnabled",
  start: "autoUpdateStart",
  end: "autoUpdateEnd",
} as const;

export type AutoUpdateSettings = {
  enabled: boolean;
  /** "HH:MM" 24-hour, station time. */
  start: string;
  end: string;
};

export type AutoTickInput = {
  settings: AutoUpdateSettings;
  /** Station IANA zone; null when the backend could not be reached. */
  timeZone: string | null;
  serverNow: Date;
  updateAvailable: boolean;
  latestLabel: string | null;
  channel: UpdateChannel;
  listeners: number | null;
  job: UpdateJob | null;
  /** A failed job this fresh suppresses retries — something is wrong, and
   * hammering GitHub and the build every minute will not fix it. */
  failedCooldownMs?: number;
};

export type AutoTickDecision =
  | { start: false; reason: string }
  | { start: true; reason: string };

const FAILED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Should this tick start an update? Pure — the route, the scheduler and the
 * tests all get the same answer for the same inputs.
 */
export function decideAutoTick(input: AutoTickInput): AutoTickDecision {
  if (!input.settings.enabled) return { start: false, reason: "automatic updates off" };
  const start = parseTimeOfDay(input.settings.start);
  const end = parseTimeOfDay(input.settings.end);
  if (!start || !end) return { start: false, reason: "update window incomplete" };
  if (start === end) return { start: false, reason: "update window is zero-length" };

  const nowMin =
    input.timeZone === null
      ? input.serverNow.getHours() * 60 + input.serverNow.getMinutes()
      : minutesInZone(input.serverNow, input.timeZone);
  if (nowMin === null) return { start: false, reason: "station timezone unreadable" };
  if (!isInWindow(nowMin, toMinutes(start), toMinutes(end))) {
    return { start: false, reason: "outside the update window" };
  }
  if (jobRunning(input.job)) return { start: false, reason: "an update is already running" };
  if (
    input.job?.status === "failed" &&
    Date.now() - Date.parse(input.job.updatedAt) < (input.failedCooldownMs ?? FAILED_COOLDOWN_MS)
  ) {
    return { start: false, reason: "last automatic update failed recently" };
  }
  if (!input.updateAvailable) return { start: false, reason: "nothing new on this channel" };
  // Fail closed twice: an unreadable room and an occupied room both wait.
  // There is no confirm checkbox here — nobody is watching to tick it.
  if (input.listeners === null) return { start: false, reason: "listener count unreadable" };
  if (input.listeners > 0) return { start: false, reason: `${input.listeners} listener(s) on air` };
  return { start: true, reason: `quiet in window, ${input.latestLabel || "update"} available` };
}

// Station timezone, cached hourly. Anonymous endpoint — no credentials needed,
// which matters because this runs pre-auth at boot and on every tick.
const TZ_CACHE_MS = 60 * 60 * 1000;
let tzCache: { at: number; tz: string | null } | null = null;

export async function resolveStationTimezone(): Promise<string | null> {
  if (tzCache && Date.now() - tzCache.at < TZ_CACHE_MS) return tzCache.tz;
  let tz: string | null = null;
  try {
    const cfg = await getSubwaveConfig();
    if (cfg.apiUrl) {
      const res = await fetch(`${cfg.apiUrl}/state`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const d = (await res.json()) as any;
        if (typeof d?.timezone === "string" && d.timezone) {
          // Validate by using it — an unknown zone throws here, not later.
          minutesInZone(new Date(), d.timezone);
          tz = d.timezone;
        }
      }
    }
  } catch {
    // backend unreachable — caller falls back
  }
  tzCache = { at: Date.now(), tz };
  return tz;
}

export async function readAutoUpdateSettings(): Promise<AutoUpdateSettings> {
  const defaults: AutoUpdateSettings = { enabled: false, start: "", end: "" };
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [AUTO_UPDATE_KEYS.enabled, AUTO_UPDATE_KEYS.start, AUTO_UPDATE_KEYS.end] } },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value || "";
    const start = parseTimeOfDay(get(AUTO_UPDATE_KEYS.start)) || "";
    const end = parseTimeOfDay(get(AUTO_UPDATE_KEYS.end)) || "";
    return { enabled: get(AUTO_UPDATE_KEYS.enabled) === "true", start, end };
  } catch {
    return defaults;
  }
}

/**
 * One scheduler tick, callable on its own (which is how it is tested against a
 * scratch station). Returns what it decided; starts the pipeline without
 * awaiting when the answer is yes.
 */
export async function runAutoUpdateTick(appDir: string): Promise<AutoTickDecision> {
  const settings = await readAutoUpdateSettings();
  const [tz, status, listeners, job] = await Promise.all([
    resolveStationTimezone(),
    getUpdateStatus().catch(() => null),
    listenerCount(),
    readJob(appDir),
  ]);

  const channel = status?.channel || "release";
  const decision = decideAutoTick({
    settings,
    timeZone: tz,
    serverNow: new Date(),
    updateAvailable: status?.updateAvailable === true,
    latestLabel: status?.latest || null,
    channel,
    listeners,
    job,
  });

  // A detected update is announced once per ref — but never before its tarball
  // is downloaded and verified. A notification is a promise that the update is
  // installable; without the file on disk it would be a guess. This runs even
  // when the room is occupied (no quiet room needed to TELL someone), and the
  // staged file is what the pipeline itself installs from.
  if (status?.updateAvailable && status.latest) {
    try {
      await notifyOnce(appDir, channel, status.latest);
    } catch (e) {
      console.warn("[auto-update] notify failed:", e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150));
    }
  }

  if (!decision.start) return decision;

  let plan: UpdatePlan;
  try {
    if (channel === "release") {
      if (!status?.latest) return { start: false, reason: "release label missing" };
      const info = await fetchRelease(status.latest);
      plan = { channel, version: info.version, tag: info.tag, tarballUrl: info.tarballUrl, sha: null, notes: info.notes };
    } else {
      const head = await fetchBranchHead(channel);
      const source = await readSource(appDir);
      if (isSameSource(source, channel, head.sha)) {
        return { start: false, reason: "already on this tip" };
      }
      plan = {
        channel,
        version: `${channel}@${head.sha.slice(0, 7)}`,
        tag: channel,
        tarballUrl: head.tarballUrl,
        sha: head.sha,
        notes: null,
      };
    }
  } catch (e) {
    return { start: false, reason: `could not resolve target: ${(e as Error)?.message || "unknown"}` };
  }

  const newJob: UpdateJob = {
    status: "running",
    from: status?.current || "unknown",
    to: plan.version,
    backupId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [`automatic update to ${channel === "release" ? `v${plan.version}` : plan.version} started`],
    trigger: "auto",
  };
  await writeJob(appDir, newJob);

  runUpdatePipeline(appDir, plan).catch(async (e) => {
    const j = (await readJob(appDir)) || newJob;
    j.status = "failed";
    j.error = (e as Error)?.message || "update crashed";
    await writeJob(appDir, j);
  });

  return { start: true, reason: decision.reason };
}

/**
 * Tell the admins about a ref once — after its tarball is downloaded and
 * verified, never before. Returns silently when there is nothing new to say.
 * Staging failures mean "cannot prove it installs": no notification, and the
 * caller (the tick) treats the update as not actionable this minute.
 */
export async function notifyOnce(appDir: string, channel: UpdateChannel, label: string): Promise<void> {
  // The label is display text ("0.0.3" or "develop@abc1234"); the ref behind it
  // is what identifies the update exactly.
  let ref: string;
  if (channel === "release") {
    ref = label;
  } else {
    const { fetchBranchHead } = await import("@/lib/update-run");
    ref = (await fetchBranchHead(channel)).sha;
  }
  const row = await prisma.setting
    .findUnique({ where: { key: UPDATE_NOTIFIED_KEY } })
    .catch(() => null);
  if (!shouldNotifyForRef(row?.value || null, channel, ref)) return;

  const { ensureStagedTarball } = await import("@/lib/update-run");
  const { releaseTarballUrl, channelTarballUrl } = await import("@/lib/update");
  const url = channel === "release" ? releaseTarballUrl(ref) : channelTarballUrl(channel);
  await ensureStagedTarball(appDir, channel, ref, url);

  const title =
    channel === "release" ? `Update available: v${ref}` : `Developer update available (${channel}@${ref.slice(0, 7)})`;
  await pushToAdmins(title, "Downloaded and verified — tap to review and install in Admin → System → Software.", "/admin");
  await prisma.setting.upsert({
    where: { key: UPDATE_NOTIFIED_KEY },
    update: { value: notifiedRefFor(channel, ref) },
    create: { key: UPDATE_NOTIFIED_KEY, value: notifiedRefFor(channel, ref) },
  });
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Every minute, forever. Defensive throughout: a tick must never throw, or
 * the interval dies with it and the station silently stops checking. */
export function startAutoUpdateScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    runAutoUpdateTick(process.cwd()).catch((e) => {
      console.warn("[auto-update] tick failed:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    });
  }, 60 * 1000);
}
