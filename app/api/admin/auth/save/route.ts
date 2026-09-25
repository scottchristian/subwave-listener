import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { execFile } from "node:child_process";
import { authOptions } from "../../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { updateEnvFile } from "@/lib/envfile";

const PM2_BIN = process.env.PM2_BIN || "/usr/bin/pm2";

// Save Google sign-in + admin email to the DB (for display) AND mirror them
// into the server .env.local, then restart so NextAuth picks them up —
// provider credentials are read once at boot and cannot hot-reload.
// NEXTAUTH_SECRET deliberately stays env-only (it guards JWT decode).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { googleClientId?: unknown; googleClientSecret?: unknown; adminEmail?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const googleClientId = String(body.googleClientId ?? "").trim();
  const googleClientSecret = String(body.googleClientSecret ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();
  if (!googleClientId || !googleClientSecret || !adminEmail) {
    return NextResponse.json(
      { error: "Client ID, client secret and admin email are all required" },
      { status: 400 }
    );
  }

  try {
    for (const [key, value] of [
      ["googleClientId", googleClientId],
      ["googleClientSecret", googleClientSecret],
      ["adminEmail", adminEmail],
    ] as const) {
      await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    const { updated } = await updateEnvFile({
      GOOGLE_CLIENT_ID: googleClientId,
      GOOGLE_CLIENT_SECRET: googleClientSecret,
      ADMIN_EMAIL: adminEmail,
    });
    // Respond first, then bounce: in-flight streams reconnect via the player.
    setTimeout(() => {
      execFile(PM2_BIN, ["restart", process.env.PM2_APP_NAME || "station-web"], (err) => {
        if (err) console.error("Self-restart after auth save failed:", err.message);
      });
    }, 800);
    return NextResponse.json({ ok: true, mirrored: updated, restarting: true });
  } catch (e) {
    console.error("Auth save failed:", e);
    return NextResponse.json({ error: (e as Error).message || "Auth save failed" }, { status: 500 });
  }
}
