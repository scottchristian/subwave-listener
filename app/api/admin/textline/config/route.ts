import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readLinqConfig } from "@/lib/linq";
import { updateEnvFile } from "@/lib/envfile";

export const runtime = "nodejs";

// Read or change the Linq text-line credentials.
//
// The values live in the env file, not the Setting table, because lib/linq
// reads them from process.env on every send and the webhook verifier reads
// the secret on every delivery — there is no database row to keep in sync.
// Saving mirrors the values into process.env so the line works immediately;
// the env file is what survives the next restart.
//
// The response never carries the API key or the signing secret: whether each
// is set is all the panel needs, and both are credentials.
function publicStatus() {
  const cfg = readLinqConfig();
  const base = String(process.env.NEXTAUTH_URL || "").trim().replace(/\/+$/, "");
  return {
    enabled: cfg.enabled,
    apiKeySet: cfg.apiKey !== "",
    secretSet: cfg.webhookSecret !== "",
    webhookUrl: base ? `${base}/api/linq/webhook` : "",
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

  if (typeof body?.enabled === "boolean") {
    vars.LINQ_ENABLED = body.enabled ? "1" : "0";
  }
  // Absent or blank = unchanged. Replacing a bad key means pasting a new one,
  // not clearing the field — a blank save must never quietly unbind the line.
  for (const [field, envKey, label] of [
    ["apiKey", "LINQ_API_KEY", "API key"],
    ["webhookSecret", "LINQ_WEBHOOK_SECRET", "Webhook signing secret"],
  ] as const) {
    if (body?.[field] === undefined || body?.[field] === null) continue;
    const value = String(body[field]).trim();
    if (value === "") continue;
    if (/\s/.test(value)) {
      return NextResponse.json(
        { error: `${label} may not contain spaces or newlines.` },
        { status: 400 }
      );
    }
    vars[envKey] = value;
  }

  // The line needs both halves: the key to send, the secret to trust what
  // arrives. Validated against what will be saved, before anything is written.
  const nextKey = vars.LINQ_API_KEY ?? String(process.env.LINQ_API_KEY ?? "").trim();
  const nextSecret = vars.LINQ_WEBHOOK_SECRET ?? String(process.env.LINQ_WEBHOOK_SECRET ?? "").trim();
  if (body?.enabled === true && (!nextKey || !nextSecret)) {
    return NextResponse.json(
      { error: "Save the API key and webhook signing secret before switching the text line on." },
      { status: 400 }
    );
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
  // the next send or inbound webhook reads process.env, so this IS the apply.
  for (const key of Object.keys(vars)) process.env[key] = vars[key];

  return NextResponse.json(publicStatus());
}
