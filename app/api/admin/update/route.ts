import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { APP_VERSION } from "@/lib/version";
import {
  preflight,
  runUpdatePipeline,
  fetchRelease,
  fetchBranchHead,
  listenerCount,
  type UpdatePlan,
} from "@/lib/update-run";
import { readJob, writeJob, canStartUpdate, gateOnListeners, parseChannel, readSource, isSameSource } from "@/lib/update";
import { readAutoUpdateSettings, resolveStationTimezone } from "@/lib/auto-update";
import type { UpdateJob } from "@/lib/update";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return false;
  return true;
}

// Status + preflight. Detection itself lives in the update-check route; this is
// what the update panel polls while a job runs — including across the pm2
// restart at the end, which the job file survives and the process does not.
export async function GET() {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  const [job, pre, source, auto, stationTimezone] = await Promise.all([
    readJob(),
    preflight(process.cwd()),
    readSource(),
    readAutoUpdateSettings(),
    resolveStationTimezone(),
  ]);
  return NextResponse.json({
    current: APP_VERSION,
    job,
    source,
    auto,
    stationTimezone,
    preflight: {
      diskBytes: pre.diskBytes,
      diskOk: pre.diskOk,
      diskWarn: pre.diskWarn,
      npmOk: pre.npm !== null,
      tarOk: pre.tar,
      prismaOk: pre.prisma,
    },
  });
}

export async function POST(req: Request) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });
  const appDir = process.cwd();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const startable = canStartUpdate(await readJob(appDir));
  if (!startable.ok) {
    return NextResponse.json({ error: startable.error }, { status: 409 });
  }

  // Confirm the target exists and is an upgrade before touching anything.
  // Channels: "release" takes a version (defaulting to the latest stable),
  // "main" and "develop" take the branch tip — for operators who want the next
  // release early or are testing one.
  let channel: "release" | "main" | "develop";
  try {
    channel = parseChannel(body.channel ?? "release");
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "bad channel" }, { status: 400 });
  }

  let plan: UpdatePlan;
  try {
    if (channel === "release") {
      const info = await fetchRelease(body.target);
      plan = {
        channel,
        version: info.version,
        tag: info.tag,
        tarballUrl: info.tarballUrl,
        sha: null,
        notes: info.notes,
      };
    } else {
      const head = await fetchBranchHead(channel);
      const source = await readSource(appDir);
      if (isSameSource(source, channel, head.sha)) {
        return NextResponse.json(
          { error: `Already on ${channel} @ ${head.sha.slice(0, 7)} — nothing to install` },
          { status: 400 }
        );
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
    return NextResponse.json({ error: (e as Error)?.message || "bad target" }, { status: 400 });
  }

  // The on-air gate, same rule as deploy.sh (see gateOnListeners).
  const gated = gateOnListeners(await listenerCount(), body.confirmListeners === true);
  if (!gated.ok) {
    return NextResponse.json(
      { error: gated.error, listeners: gated.listeners, needsConfirm: true },
      { status: 409 }
    );
  }

  const job: UpdateJob = {
    status: "running",
    from: APP_VERSION,
    to: plan.version,
    backupId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: "manual",
    log: [`update to ${plan.channel === "release" ? `v${plan.version}` : plan.version} started`],
  };
  await writeJob(appDir, job);

  // Not awaited: the client polls GET. runUpdatePipeline catches its own
  // failures into the job file; this catch is only for the truly unexpected.
  runUpdatePipeline(appDir, plan).catch(async (e) => {
    const j = (await readJob(appDir)) || job;
    j.status = "failed";
    j.error = (e as Error)?.message || "update crashed";
    await writeJob(appDir, j);
  });

  return NextResponse.json({ ok: true, started: true, to: plan.version, channel: plan.channel });
}
