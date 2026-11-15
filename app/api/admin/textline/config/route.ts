import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  readLinqConfig,
  type ApiFailure,
} from "@/lib/linq";
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
function publicBase(): string {
  return String(process.env.NEXTAUTH_URL || "").trim().replace(/\/+$/, "");
}

function publicStatus() {
  const cfg = readLinqConfig();
  const base = publicBase();
  return {
    enabled: cfg.enabled,
    apiKeySet: cfg.apiKey !== "",
    secretSet: cfg.webhookSecret !== "",
    webhookUrl: base ? `${base}/api/linq/webhook` : "",
  };
}

async function persistEnv(vars: Record<string, string>) {
  await updateEnvFile(vars);
  for (const key of Object.keys(vars)) process.env[key] = vars[key];
}

function linqFailure(failure: ApiFailure, what: string) {
  if (failure.status === 401 || failure.status === 403) {
    return NextResponse.json(
      { error: "Linq rejected the API key. Check it and try again." },
      { status: 400 }
    );
  }
  return NextResponse.json({ error: `${what}: ${failure.error}.` }, { status: 502 });
}

/**
 * The panel's "Set up webhook": register this station's address for inbound
 * texts and store the signing secret Linq returns, because Linq shows that
 * secret exactly once. Any subscription already pointing at this address is
 * replaced — that is the only way to obtain a secret we can keep, and it is
 * also the recovery path when a stored secret no longer matches.
 */
async function setupWebhook(body: any) {
  const typedKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (typedKey && /\s/.test(typedKey)) {
    return NextResponse.json({ error: "API key may not contain spaces or newlines." }, { status: 400 });
  }
  const key = typedKey || readLinqConfig().apiKey;
  if (!key) {
    return NextResponse.json({ error: "Paste your Linq API key first." }, { status: 400 });
  }

  const base = publicBase();
  if (!base) {
    return NextResponse.json(
      { error: "Set NEXTAUTH_URL to the station's public address first — the webhook needs somewhere to point." },
      { status: 400 }
    );
  }
  const targetUrl = `${base}/api/linq/webhook`;
  if (!targetUrl.startsWith("https://")) {
    return NextResponse.json(
      { error: "Linq only accepts HTTPS webhook addresses. Set NEXTAUTH_URL to your station's https address." },
      { status: 400 }
    );
  }

  // A key typed into the panel is the key the operator means to keep, so it is
  // saved before the Linq calls that need it.
  if (typedKey) {
    try {
      await persistEnv({ LINQ_API_KEY: typedKey });
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not save the API key: ${String(e?.message || e)}` },
        { status: 500 }
      );
    }
  }

  const listed = await listWebhookSubscriptions();
  if (!listed.ok) return linqFailure(listed, "Could not list Linq webhooks");

  const normalise = (url: string) => url.replace(/\/+$/, "");
  for (const sub of listed.subscriptions) {
    if (normalise(sub.targetUrl) !== targetUrl) continue;
    const removed = await deleteWebhookSubscription(sub.id);
    if (!removed.ok) return linqFailure(removed, "Could not replace the existing webhook");
  }

  const created = await createWebhookSubscription(targetUrl);
  if (!created.ok) return linqFailure(created, "Could not create the webhook");

  try {
    await persistEnv({ LINQ_WEBHOOK_SECRET: created.signingSecret });
  } catch (e: any) {
    return NextResponse.json(
      {
        error:
          "Linq created the webhook but the signing secret could not be saved. " +
          "Press Set up webhook again — it replaces the subscription with a fresh secret. " +
          `(${String(e?.message || e)})`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json(publicStatus());
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

  const action = typeof body?.action === "string" ? body.action : "save";
  if (action === "setup") return setupWebhook(body);
  if (action !== "save") {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
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
      { error: "Save the API key and set up the webhook before switching the text line on." },
      { status: 400 }
    );
  }

  try {
    // Mirror into the running process — the env file is only read at boot, and
    // the next send or inbound webhook reads process.env, so this IS the apply.
    await persistEnv(vars);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not save: ${String(e?.message || e)}` },
      { status: 500 }
    );
  }

  return NextResponse.json(publicStatus());
}
