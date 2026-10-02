import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { APP_VERSION } from "@/lib/version";
import { preflight, runUpdatePipeline, fetchRelease, listenerCount } from "@/lib/update-run";
import { readJob, writeJob, jobRunning } from "@/lib/update";
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
  const [job, pre] = await Promise.all([readJob(), preflight(process.cwd())]);
  return NextResponse.json({
    current: APP_VERSION,
    job,
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

  const existing = await readJob(appDir);
  if (jobRunning(existing)) {
    return NextResponse.json({ error: "An update is already running" }, { status: 409 });
  }

  // Confirm the target exists and is an upgrade before touching anything.
  let info;
  try {
    info = await fetchRelease(body.target);
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "bad target" }, { status: 400 });
  }

  // The on-air gate, same rule as deploy.sh: refuse with listeners unless the
  // operator confirms knowing the count. Unknown counts as listeners present.
  const listeners = await listenerCount();
  if ((listeners === null || listeners > 0) && body.confirmListeners !== true) {
    return NextResponse.json(
      {
        error:
          listeners === null
            ? "Could not read the listener count — confirm to update blind, or wait until the room is verifiably empty."
            : `${listeners} listener(s) on air — confirm to interrupt them, or wait until the room is empty.`,
        listeners,
        needsConfirm: true,
      },
      { status: 409 }
    );
  }

  const job: UpdateJob = {
    status: "running",
    from: APP_VERSION,
    to: info.version,
    backupId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    log: [`update to v${info.version} started`],
  };
  await writeJob(appDir, job);

  // Not awaited: the client polls GET. runUpdatePipeline catches its own
  // failures into the job file; this catch is only for the truly unexpected.
  runUpdatePipeline(appDir, info.version).catch(async (e) => {
    const j = (await readJob(appDir)) || job;
    j.status = "failed";
    j.error = (e as Error)?.message || "update crashed";
    await writeJob(appDir, j);
  });

  return NextResponse.json({ ok: true, started: true, to: info.version });
}
