import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { updateEnvFile } from "@/lib/envfile";
import {
  clampSeconds,
  readConfig,
  reconfigure,
  snapshot,
  MAX_SECONDS,
  MIN_SECONDS,
} from "@/lib/dbkeepalive";
import { providerFromEnv } from "@/lib/db-provider";

export const runtime = "nodejs";

// Read or change the keep-alive setting.
//
// The value is written to the env file, not the Setting table, because the
// database is the thing that may be asleep. Changing it applies to the running
// timer immediately — no restart, and the next ping uses the new interval.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    ...snapshot(),
    provider: providerFromEnv(),
    min: MIN_SECONDS,
    max: MAX_SECONDS,
  });
}

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

  const enabled = body?.enabled === true;
  const seconds = clampSeconds(body?.seconds);

  if (enabled && providerFromEnv() !== "postgresql") {
    return NextResponse.json(
      {
        error:
          "This only applies to Postgres. While the station runs on SQLite there is no remote database to keep awake.",
      },
      { status: 400 }
    );
  }
  if (enabled && seconds < 60) {
    // Not blocked, but worth saying: some free tiers count frequent pokes as
    // abuse, and 30s is far more often than a suspended compute needs.
    return NextResponse.json(
      {
        error: `Pick at least 60 seconds. ${MIN_SECONDS} is the floor and ${seconds}s is aggressive enough that some providers may treat it as abuse.`,
      },
      { status: 400 }
    );
  }

  try {
    await updateEnvFile({
      DB_KEEPALIVE: enabled ? "1" : "0",
      DB_KEEPALIVE_SECONDS: String(seconds),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not save: ${String(e?.message || e)}` },
      { status: 500 }
    );
  }

  // Apply to the live timer. The env file is only read at boot and per tick, so
  // without this the change would not take effect until the next deploy.
  reconfigure(enabled, seconds);

  // Layerbase free databases must sleep, and this switch defeats the sleep.
  // Warn, don't refuse: it is the operator's database and their TOS to keep.
  const dbUrl = process.env.DATABASE_URL || "";
  const layerbaseWarning =
    enabled && /layerbase/i.test(dbUrl)
      ? "This connection string is Layerbase, whose free plan requires the database to sleep. Pinging it on a timer counts as defeating the sleep window and can get the database paused. Leave it on only if you accept that risk."
      : null;

  return NextResponse.json({ ok: true, ...readConfig(), ...snapshot(), layerbaseWarning });
}
