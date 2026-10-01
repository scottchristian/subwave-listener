import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { updateEnvFile } from "@/lib/envfile";
import { providerFromEnv } from "@/lib/db-provider";
import { verifyCopy } from "@/lib/dbmigrate";
import { activeListeners } from "@/lib/listeners";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PM2_APP, PM2_BIN, PM2_APP_UNCONFIGURED, pm2AppConfigured } from "@/lib/pm2app";

const run = promisify(execFile);
const APP_DIR = process.cwd();
const SCHEMA = path.join(APP_DIR, "prisma", "schema.prisma");

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Point the canonical schema at a provider.
 *
 * This is the step that was missing, and its absence is why the first cutover
 * took the station down: Prisma bakes the provider into the generated client,
 * so rewriting DATABASE_URL alone regenerates a *SQLite* client and every
 * query then fails at runtime with "the URL must start with the protocol
 * file:". The env file and this file must move together.
 */
async function setSchemaProvider(provider: string): Promise<void> {
  const raw = await fs.readFile(SCHEMA, "utf8");
  const next = raw.replace(
    /(datasource\s+db\s*\{\s*provider\s*=\s*")[^"]*(")/,
    `$1${provider}$2`
  );
  if (next === raw && !new RegExp(`provider\\s*=\\s*"${provider}"`).test(raw)) {
    throw new Error(`could not find the datasource block in ${SCHEMA}`);
  }
  if (next !== raw) {
    await fs.writeFile(SCHEMA, next, "utf8");
  }
}

// Switch the app over to Postgres, or back to SQLite.
//
// This rewrites DATABASE_URL and DB_PROVIDER in .env.local, regenerates the
// Prisma client for the new provider, rebuilds, and restarts. The caller must
// already have copied and verified the data — this step changes only which
// database is served from.
//
// Reverting writes the previous URL straight back, so the two directions share
// one code path and the previous target stays on disk untouched.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const to = String(body?.to || "");
  if (to !== "postgresql" && to !== "sqlite") {
    return NextResponse.json({ error: "Target must be postgresql or sqlite" }, { status: 400 });
  }

  const from = providerFromEnv();
  if (from === to) {
    return NextResponse.json({ error: `Already running on ${to}.` }, { status: 400 });
  }

  let url: string;
  if (to === "postgresql") {
    url = String(body?.url || "").trim();
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      return NextResponse.json(
        { error: "A Postgres URL is required to switch to Postgres" },
        { status: 400 }
      );
    }
  } else {
    // Reverting to SQLite: use the URL the operator names, which must be the
    // SQLite file the previous copy produced. Never guess a path — writing the
    // wrong one here would point production at an empty database.
    url = String(body?.url || "").trim();
    if (!/^file:/i.test(url)) {
      return NextResponse.json(
        {
          error:
            "Reverting needs the SQLite file URL to switch back to (for example file:/var/www/your-app/data/station.db). Nothing is guessed — an empty or wrong path would leave the station serving a blank database.",
        },
        { status: 400 }
      );
    }
  }

  // Re-check the room. The copy routes gate on this, but there is an unguarded
  // window between a finished copy and this call: anyone can sign in, or a DJ can
  // start a stream, and the switch would then cut the audio out from under them
  // mid-song. A migration is not something to start on a live room, so it is
  // checked again here rather than trusted from the copy a minute ago.
  try {
    const listeners = await activeListeners();
    if (listeners.length > 0) {
      return NextResponse.json(
        {
          error: `Refusing to switch: ${listeners.length} listener(s) are on air.`,
          listeners,
          needsEmptyRoom: true,
        },
        { status: 409 }
      );
    }
  } catch (e: any) {
    // Cannot prove the room is empty, so do not switch.
    return NextResponse.json(
      { error: `Refusing to switch: could not read the listener list (${String(e?.message || e).split("\n")[0]}).` },
      { status: 503 }
    );
  }

  // Prove the copy, here, now — rather than believing the browser's word for it.
  // Previously this endpoint accepted `verified: true` as a literal from the
  // client, which meant any request could assert a verification that never
  // happened. The check is the same per-table hash the copy runs, re-read from
  // both ends, so it also catches rows that changed after the copy finished.
  let verification;
  try {
    verification = await verifyCopy({
      sourceProvider: from,
      sourceUrl: process.env.DATABASE_URL || "",
      targetProvider: to,
      targetUrl: url,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Refusing to switch: verification could not run (${String(e?.message || e).split("\n")[0]}).` },
      { status: 503 }
    );
  }
  if (!verification.ok) {
    const bad = verification.tables.filter((t) => !t.match).map((t) => t.model);
    return NextResponse.json(
      {
        error:
          "Refusing to switch: the two databases do not match." +
          (bad.length ? ` Differing: ${bad.join(", ")}.` : "") +
          (verification.failedReason ? ` ${verification.failedReason}` : ""),
        verification,
      },
      { status: 409 }
    );
  }

  // Refuse before anything is mutated. Without a process name the restart cannot
  // happen, and the old behaviour was to report `restarting: true` anyway — after
  // the env file had already been rewritten.
  if (!pm2AppConfigured()) {
    return NextResponse.json({ error: PM2_APP_UNCONFIGURED }, { status: 500 });
  }

  let backup = "";
  try {
    const res = await updateEnvFile({
      DATABASE_URL: url,
      DB_PROVIDER: to,
    });
    backup = res.backup;
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not update the environment file: ${String(e?.message || e)}` },
      { status: 500 }
    );
  }

  // The schema has to move with the env, or the regenerated client stays
  // SQLite-flavoured and every query breaks. Backed up first: if anything below
  // fails we put it back, because a half-switched schema is the failure mode
  // that takes the station down.
  let schemaBackedUp = false;
  try {
    await fs.copyFile(SCHEMA, `${SCHEMA}.bak-switch`);
    schemaBackedUp = true;
    await setSchemaProvider(to);
  } catch (e: any) {
    if (schemaBackedUp) await fs.copyFile(`${SCHEMA}.bak-switch`, SCHEMA).catch(() => {});
    return NextResponse.json(
      { error: `Could not point the schema at ${to}: ${String(e?.message || e)}. Nothing was switched.` },
      { status: 500 }
    );
  }

  // Both the env file and the schema have now been changed. If anything below
  // fails the station is mid-switch — the worst state, because the running
  // process is on the old engine while the files say otherwise. Put both back.
  const rollback = async () => {
    await fs.copyFile(`${SCHEMA}.bak-switch`, SCHEMA).catch(() => {});
    await fs.rm(`${SCHEMA}.bak-switch`, { force: true }).catch(() => {});
    try {
      await updateEnvFile({ DATABASE_URL: process.env.DATABASE_URL || "", DB_PROVIDER: from });
    } catch {}
  };

  // Regenerate the Prisma client for the new provider. The generated code is
  // provider-specific, so without this the app would keep querying the old
  // engine and fail every request.
  try {
    await run(/* turbopackIgnore: true */ "npx", ["prisma", "generate"], {
      cwd: APP_DIR,
      timeout: 300_000,
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (e: any) {
    const out = `${e?.stdout || ""}${e?.stderr || ""}`.trim();
    await rollback();
    return NextResponse.json(
      {
        error:
          `Prisma client generation failed. Nothing was switched — schema and environment were both put back. ${out.split("\n").slice(-2).join(" · ")}`,
      },
      { status: 500 }
    );
  }

  // Rebuild so the new client is bundled. A failed build leaves the previous
  // .next in place and we bail before restarting.
  try {
    await run("npm", ["run", "build"], {
      cwd: APP_DIR,
      timeout: 600_000,
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (e: any) {
    await rollback();
    return NextResponse.json(
      {
        error:
          "Build failed. Nothing was switched — schema and environment were both put back, and the previous version is still running.",
      },
      { status: 500 }
    );
  }

  // The response has to reach the browser before the process goes away.
  setTimeout(() => {
    execFile(/* turbopackIgnore: true */ PM2_BIN, ["restart", PM2_APP], (err) => {
      if (err) console.error("Restart after database switch failed:", err.message);
    });
  }, 800);

  await fs.rm(`${SCHEMA}.bak-switch`, { force: true }).catch(() => {});

  return NextResponse.json({
    ok: true,
    from,
    to,
    restarting: true,
    envBackup: backup,
  });
}
