import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { probePostgres } from "@/lib/pg-probe";
import { maskDatabaseUrl } from "@/lib/db-provider";

export const runtime = "nodejs";
// A cold TLS handshake to a managed database is slow on the first try.
export const maxDuration = 60;

/** Mirrors ProbeResult's shape so the UI can render either kind the same way. */
type FileProbe = {
  ok: boolean;
  ready: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  error?: string;
};

/**
 * Can we actually create a SQLite database here?
 *
 * Not the same question as "does this path look valid". A copy that only fails
 * once Prisma is halfway through leaves the operator waiting on an opaque error
 * with a half-written file, so this proves it up front.
 *
 * The throwaway file matters more than `fs.access(W_OK)`: SQLite also needs to
 * create `-wal` and `-shm` sidecars beside the database, so what has to be
 * writable is the *directory*, not just the path.
 */
function probeSqliteFile(targetFile: string): FileProbe {
  const checks: FileProbe["checks"] = [];
  const abs = path.resolve(targetFile);
  const dir = path.dirname(abs);

  if (!path.isAbsolute(targetFile)) {
    return { ok: false, ready: false, checks, error: "Use a full path, starting with /" };
  }
  if (targetFile.split(path.sep).includes("..")) {
    return { ok: false, ready: false, checks, error: "Path must not contain .." };
  }

  const dirExists = fs.existsSync(dir);
  checks.push({
    name: "folder exists",
    ok: dirExists,
    detail: dirExists ? dir : `${dir} does not exist`,
  });
  if (!dirExists) {
    return { ok: false, ready: false, checks, error: `The folder ${dir} does not exist.` };
  }

  let dirWritable = false;
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    dirWritable = true;
  } catch {
    dirWritable = false;
  }
  checks.push({
    name: "folder is writable",
    ok: dirWritable,
    detail: dirWritable ? dir : `${dir} is not writable by the app user`,
  });
  if (!dirWritable) {
    return { ok: false, ready: false, checks, error: `The app cannot write to ${dir}.` };
  }

  // Prove a real file can be created and written, then remove it. SQLite will do
  // exactly this, plus the two sidecars.
  const probePath = path.join(dir, `.subwave-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probePath, "ok");
    const wrote = fs.readFileSync(probePath, "utf8") === "ok";
    fs.unlinkSync(probePath);
    checks.push({ name: "can create a file", ok: wrote, detail: wrote ? "created and removed a test file" : "test file did not read back" });
    if (!wrote) return { ok: false, ready: false, checks, error: "Test file did not read back." };
  } catch (e: any) {
    try { fs.unlinkSync(probePath); } catch {}
    checks.push({ name: "can create a file", ok: false, detail: String(e?.message || e).split("\n")[0] });
    return { ok: false, ready: false, checks, error: `Cannot create a file in ${dir}.` };
  }

  const targetExists = fs.existsSync(abs);
  checks.push({
    name: "target is new",
    ok: !targetExists,
    detail: targetExists ? `${abs} already exists` : "no file at that path yet",
  });

  return {
    ok: !targetExists,
    ready: !targetExists,
    checks,
    ...(targetExists
      ? { error: "That file already exists. Pick a new name so an existing database is never overwritten." }
      : {}),
  };
}

/**
 * Test a migration target and report exactly what is missing.
 *
 * Two kinds, because "can we use this as the next database" is one question with
 * two answers: a Postgres URL is checked with a real permission probe (connect,
 * create, read, write, own), and a `file:` target is checked on the filesystem.
 * One endpoint, so the move flow has a single "is this target usable" step
 * whichever direction it is going.
 *
 * Read-only against the target beyond one throwaway table (dropped either way)
 * and one throwaway file (removed either way). Never writes to, or migrates, the
 * live database.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let url = "";
  try {
    const body = await req.json();
    url = String(body?.url || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!url) {
    return NextResponse.json({ error: "Paste the target connection URL or file path" }, { status: 400 });
  }

  if (/^file:/i.test(url)) {
    const file = url.replace(/^file:/i, "");
    try {
      const result = probeSqliteFile(file);
      return NextResponse.json({ ...result, url: `file:${file}` }, { status: result.ready ? 200 : 400 });
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not check that path: ${String(e?.message || e).split("\n")[0]}` },
        { status: 500 }
      );
    }
  }

  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "That is not a supported target — it should start with postgresql:// or file:" },
      { status: 400 }
    );
  }

  try {
    const result = await probePostgres(url);
    // The probe never echoes the URL back with a password in it.
    return NextResponse.json({ ...result, url: maskDatabaseUrl(url) });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Permission check failed: ${String(e?.message || e).trim().split("\n")[0]}` },
      { status: 500 }
    );
  }
}