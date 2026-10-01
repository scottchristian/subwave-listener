import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";

// Effective config for the admin UI: DB value wins, server env is fallback.
// Lets fields show what's actually live even before anything was saved here.
// Admin-only like the settings it mirrors (secrets included).
const KEYS: Record<string, string> = {
  donate_url: "",
  donate_text: "",
  stationPassword: "",
  subwaveApiUrl: "SUBWAVE_API_URL",
  subwaveStreamUrl: "SUBWAVE_STREAM_URL",
  subwaveAdminUser: "SUBWAVE_ADMIN_USER",
  subwaveAdminPass: "SUBWAVE_ADMIN_PASS",
  googleClientId: "GOOGLE_CLIENT_ID",
  googleClientSecret: "GOOGLE_CLIENT_SECRET",
  adminEmail: "ADMIN_EMAIL",
  vapidPublicKey: "VAPID_PUBLIC_KEY",
  vapidPrivateKey: "VAPID_PRIVATE_KEY",
  vapidSubject: "VAPID_SUBJECT",
  spotifyClientId: "SPOTIFY_CLIENT_ID",
  spotifyClientSecret: "SPOTIFY_CLIENT_SECRET",
  bmacWebhookSecret: "BMAC_WEBHOOK_SECRET",
};

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const rows = await prisma.setting.findMany({
    where: { key: { in: Object.keys(KEYS) } },
  });
  const db: Record<string, string> = {};
  for (const r of rows) db[r.key] = r.value;
  const out: Record<string, { value: string; source: "db" | "env" | "blank" }> = {};
  for (const [key, envName] of Object.entries(KEYS)) {
    if (db[key]) out[key] = { value: db[key], source: "db" };
    else if (envName && process.env[envName]) out[key] = { value: process.env[envName] as string, source: "env" };
    else out[key] = { value: "", source: "blank" };
  }
  return NextResponse.json(out);
}
