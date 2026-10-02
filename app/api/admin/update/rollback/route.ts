import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { runManualRollback } from "@/lib/update-run";
import { readJob, writeJob, jobRunning } from "@/lib/update";

// Manual rollback to the pre-update snapshot + settings backup. Only meaningful
// when a previous update left both behind — i.e. a job exists with a backupId.
// Requires explicit confirmation; like restore, there is no undo except the
// state this call itself replaces.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });
  const appDir = process.cwd();

  let confirm = false;
  try {
    confirm = (await req.json())?.confirm === true;
  } catch {
    // no body — unconfirmed
  }
  if (!confirm) {
    return NextResponse.json({ error: "rollback needs explicit confirmation" }, { status: 400 });
  }

  const job = await readJob(appDir);
  if (jobRunning(job)) {
    return NextResponse.json({ error: "An update is currently running" }, { status: 409 });
  }
  if (!job?.backupId) {
    return NextResponse.json({ error: "Nothing to roll back to — no update backup on record" }, { status: 400 });
  }

  job.status = "running";
  job.log = [...job.log.slice(-49), `manual rollback to pre-update state started`];
  await writeJob(appDir, job);

  runManualRollback(appDir, job.backupId)
    .then(async () => {
      const j = (await readJob(appDir)) || job;
      j.status = "rolled-back";
      j.error = undefined;
      j.log = [...j.log.slice(-49), "rolled back — restarting"];
      await writeJob(appDir, j);
    })
    .catch(async (e) => {
      const j = (await readJob(appDir)) || job;
      j.status = "failed";
      j.error = `rollback failed: ${(e as Error)?.message}`;
      await writeJob(appDir, j);
    });

  return NextResponse.json({ ok: true, started: true });
}
