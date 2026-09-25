import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { updateEnvFile } from "@/lib/envfile";

const run = promisify(execFile);
const PM2_BIN = process.env.PM2_BIN || "/usr/bin/pm2";
const APP_DIR = process.cwd();

// Current public identity values (all public info — safe to serve to admin).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    name: process.env.NEXT_PUBLIC_STATION_NAME || "",
    tagline: process.env.NEXT_PUBLIC_STATION_TAGLINE || "",
    description: process.env.NEXT_PUBLIC_STATION_DESCRIPTION || "",
    about: process.env.NEXT_PUBLIC_STATION_ABOUT || "",
    logo: process.env.NEXT_PUBLIC_STATION_LOGO || "",
    backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || "",
    donateUrl: process.env.NEXT_PUBLIC_DONATE_URL || "",
    nextauthUrl: process.env.NEXTAUTH_URL || "",
  });
}

// Save station identity (NEXT_PUBLIC_* — baked at build time), then rebuild
// and restart so the new branding goes live. The restart only happens when
// the build actually produced a fresh .next/BUILD_ID — a failed build keeps
// serving the old bundle instead of crash-looping. NEXTAUTH_SECRET,
// DATABASE_URL and PM2_APP_NAME stay env-only on purpose.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const str = (k: string) => String(body[k] ?? "").trim();
  const name = str("name");
  const tagline = str("tagline");
  const description = str("description");
  const about = str("about");
  const logo = str("logo");
  const backendUrl = str("backendUrl");
  const donateUrl = str("donateUrl");
  const nextauthUrl = str("nextauthUrl");
  if (!name || !backendUrl || !nextauthUrl) {
    return NextResponse.json(
      { error: "Station name, backend URL and app URL are required" },
      { status: 400 }
    );
  }
  for (const [label, v] of [["backend URL", backendUrl], ["app URL", nextauthUrl]] as const) {
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return NextResponse.json({ error: `${label} must be an http(s) URL` }, { status: 400 });
    }
  }

  try {
    await updateEnvFile({
      NEXT_PUBLIC_STATION_NAME: name,
      NEXT_PUBLIC_STATION_TAGLINE: tagline,
      NEXT_PUBLIC_STATION_DESCRIPTION: description,
      NEXT_PUBLIC_STATION_ABOUT: about,
      NEXT_PUBLIC_STATION_LOGO: logo,
      NEXT_PUBLIC_BACKEND_URL: backendUrl,
      NEXT_PUBLIC_DONATE_URL: donateUrl,
      NEXTAUTH_URL: nextauthUrl,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Env save failed" }, { status: 500 });
  }

  const before = Date.now();
  try {
    await run("npm", ["run", "build"], { cwd: APP_DIR, timeout: 600_000 });
  } catch (e: any) {
    console.error("Identity rebuild failed:", e?.message || e);
    return NextResponse.json(
      { error: "Build failed — old version still running, .env kept" },
      { status: 500 }
    );
  }
  let fresh = false;
  try {
    const st = await stat(`${APP_DIR}/.next/BUILD_ID`);
    fresh = st.mtimeMs > before;
  } catch {}
  if (!fresh) {
    return NextResponse.json(
      { error: "Build produced no fresh output — old version still running" },
      { status: 500 }
    );
  }
  setTimeout(() => {
    execFile(PM2_BIN, ["restart", process.env.PM2_APP_NAME || "station-web"], (err) => {
      if (err) console.error("Self-restart after identity save failed:", err.message);
    });
  }, 800);
  return NextResponse.json({ ok: true, restarting: true });
}
