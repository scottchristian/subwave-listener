import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readConfig, lastStatus } from "@/lib/ntfy";
import { updateEnvFile } from "@/lib/envfile";

export const runtime = "nodejs";

// Read or change the ntfy admin-alert configuration.
//
// The values live in the env file, not the Setting table, because this
// channel must work while the database is down — which is exactly when it
// alerts. Saving mirrors the values into process.env so they take effect
// without a restart (unlike the keep-alive there is no live timer here).
//
// The response never carries the topic or the token: knowing whether they
// are set is all the panel needs, and the topic is a shared secret.
function publicStatus() {
  const cfg = readConfig();
  return {
    enabled: cfg.enabled,
    topicSet: cfg.topic !== "",
    baseUrl: cfg.baseUrl,
    hasToken: cfg.token !== "",
    ...lastStatus(),
  };
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(publicStatus());
}

export async function POST(req: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const vars: Record<string, string> = {};
  let clearToken = false;

  if (typeof body?.enabled === "boolean") {
    vars.NTFY_ENABLED = body.enabled ? "1" : "0";
  }
  if (body?.topic !== undefined && body.topic !== null) {
    const topic = String(body.topic).trim();
    if (/\s/.test(topic)) {
      return NextResponse.json(
        { error: "Topic may not contain spaces or newlines." },
        { status: 400 }
      );
    }
    vars.NTFY_TOPIC = topic; // "" clears the line
  }
  if (body?.baseUrl !== undefined && body.baseUrl !== null) {
    const baseUrl = String(body.baseUrl).trim();
    if (/\s/.test(baseUrl)) {
      return NextResponse.json(
        { error: "Server URL may not contain spaces or newlines." },
        { status: 400 }
      );
    }
    if (baseUrl !== "" && !/^https?:\/\//.test(baseUrl)) {
      return NextResponse.json(
        { error: "Server URL must start with http:// or https://." },
        { status: 400 }
      );
    }
    vars.NTFY_BASE_URL = baseUrl; // "" clears the line, back to the default
  }
  // Token absent = unchanged; "" = clear; otherwise replace.
  if (body?.token !== undefined && body.token !== null) {
    const token = String(body.token);
    if (/\s/.test(token)) {
      return NextResponse.json(
        { error: "Access token may not contain spaces or newlines." },
        { status: 400 }
      );
    }
    vars.NTFY_TOKEN = token;
    clearToken = token === "";
  }

  try {
    await updateEnvFile(vars);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not save: ${String(e?.message || e)}` },
      { status: 500 }
    );
  }

  // Mirror into the running process — the env file is only read at boot, and
  // there is no live object to reconfigure, so this IS the apply step.
  if (vars.NTFY_ENABLED !== undefined) process.env.NTFY_ENABLED = vars.NTFY_ENABLED;
  if (vars.NTFY_TOPIC !== undefined) {
    if (vars.NTFY_TOPIC === "") delete process.env.NTFY_TOPIC;
    else process.env.NTFY_TOPIC = vars.NTFY_TOPIC;
  }
  if (vars.NTFY_BASE_URL !== undefined) {
    if (vars.NTFY_BASE_URL === "") delete process.env.NTFY_BASE_URL;
    else process.env.NTFY_BASE_URL = vars.NTFY_BASE_URL;
  }
  if (vars.NTFY_TOKEN !== undefined) {
    if (clearToken) delete process.env.NTFY_TOKEN;
    else process.env.NTFY_TOKEN = vars.NTFY_TOKEN;
  }

  return NextResponse.json(publicStatus());
}
