// What state is this installation in, and what does the wizard need next?
//
// Public only while setup is incomplete — see isSetupOpen in proxy.ts, and
// do not copy that check. The route below re-checks it itself, because a gate
// that lives only in the proxy is one refactor away from being bypassed.

import { NextResponse } from "next/server";
import {
  isSetupComplete,
  runningAsRoot,
  readEnvValues,
  markerPath,
} from "@/lib/setup";
import { getServerSession } from "next-auth";
import prisma from "@/lib/prisma";
import { authOptions } from "../../auth/[...nextauth]/route";

const WATCHED = [
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "PII_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ADMIN_EMAIL",
  "DATABASE_URL",
  "DB_PROVIDER",
  "NEXT_PUBLIC_STATION_NAME",
  "NEXT_PUBLIC_BACKEND_URL",
  "PM2_APP_NAME",
];

export async function GET() {
  if (isSetupComplete()) {
    return NextResponse.json({ error: "Setup is already complete" }, { status: 404 });
  }

  const env = readEnvValues(WATCHED);
  const has = (k: string) => Boolean(env[k] && env[k].trim());

  // The Subwave host credentials live in the database, not the environment.
  // A database that is not up yet simply reports the step as unfinished, which is
  // what it is — the database step comes before this one.
  const sw: Record<string, string> = { subwaveApiUrl: "", subwaveAdminUser: "", subwaveAdminPass: "" };
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: Object.keys(sw) } },
      select: { key: true, value: true },
    });
    for (const r of rows) sw[r.key] = r.value || "";
  } catch {
    // not migrated yet, or unreachable — leave the blanks
  }

  // Who am I, if anyone? Once the Google credentials are in place the operator
  // signs in, and the account that signs in first becomes the admin. Reported
  // here so the wizard can show progress across the page reloads that a restart
  // causes.
  let signedIn: { name?: string; isAdmin: boolean } | null = null;
  try {
    const session = await getServerSession(authOptions);
    if (session?.user) {
      signedIn = {
        name: (session.user as any).name || undefined,
        isAdmin: Boolean((session.user as any).isAdmin),
      };
    }
  } catch {
    // No database yet is the normal state on step one; not an error.
  }

  return NextResponse.json({
    complete: false,
    marker: markerPath(),
    runningAsRoot: runningAsRoot(),
    // Public values only. Secrets are reported as present/absent, never echoed.
    nextauthUrl: env.NEXTAUTH_URL || "",
    googleConfigured: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET"),
    secretsReady: has("NEXTAUTH_SECRET") && has("PII_ENCRYPTION_KEY"),
    adminEmail: has("ADMIN_EMAIL"),
    databaseConfigured: has("DATABASE_URL"),
    provider: (env.DB_PROVIDER || "").toLowerCase(),
    stationName: env.NEXT_PUBLIC_STATION_NAME || "",
    backendUrl: env.NEXT_PUBLIC_BACKEND_URL || "",
    pm2Configured: has("PM2_APP_NAME"),
    signedIn,
    steps: {
      secrets: has("NEXTAUTH_SECRET") && has("PII_ENCRYPTION_KEY"),
      google: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET"),
      signedIn: Boolean(signedIn?.isAdmin),
      database: has("DATABASE_URL"),
      // The host credentials. In the Setting table, because that is where
      // getSubwaveConfig() reads them from and where Admin -> Sub/Wave Server
      // writes them — so this step needs no rebuild, which is why it can sit
      // before the one that does.
      subwave: Boolean(sw.subwaveApiUrl && sw.subwaveAdminUser && sw.subwaveAdminPass),
      // The name is NOT part of this any more: it belongs to the Subwave host and
      // is read from there at runtime. Requiring it here would mean asking for it.
      station: has("NEXT_PUBLIC_BACKEND_URL"),
    },
  });
}
