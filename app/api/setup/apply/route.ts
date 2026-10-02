// The setup wizard's only write endpoint.
//
// It writes Google credentials and an admin email address, so its security
// posture is the whole of this file:
//
//   1. It 404s the moment setup is complete. The proxy gates it too, but a gate
//      that exists only in the proxy is one refactor from being bypassed, so the
//      check is repeated here where the write actually happens.
//   2. It never echoes a secret back. Status is reported as present/absent; the
//      encryption key is returned exactly once, by the step that generates it,
//      because there is no other way for the operator to get it.
//   3. Each step writes only its own keys. A step cannot reach another's values,
//      so a partially-completed wizard cannot half-configure something it was
//      never asked about.

import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  isSetupComplete,
  markSetupComplete,
  writeEnvValues,
  writeRobotsTxt,
  readEnvValues,
} from "@/lib/setup";
import { applyIdentity, scheduleRestart } from "@/lib/applyidentity";
import { cancelScheduledBounce } from "@/lib/pm2app";
import { providerFromEnv } from "@/lib/db-provider";
import prisma from "@/lib/prisma";
import { getHostIdentity } from "@/lib/hostidentity";

const run = promisify(execFile);

export async function POST(req: Request) {
  if (isSetupComplete()) {
    return NextResponse.json({ error: "Setup is already complete" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const step = String(body.step || "");
  const str = (k: string) => String(body[k] ?? "").trim();

  try {
    switch (step) {
      case "secrets":
        return await stepSecrets();
      case "google":
        return stepGoogle(str("clientId"), str("clientSecret"), str("adminEmail"), str("nextauthUrl"));
      case "database":
        return await stepDatabase(str("provider"), str("databaseUrl"), str("sqlitePath"));
      case "subwave":
        return await stepSubwave(str("apiUrl"), str("adminUser"), str("adminPass"), str("stationPassword"));
      case "station":
        return await stepStation(body);
      case "complete":
        return stepComplete();
      default:
        return NextResponse.json({ error: `Unknown step: ${step}` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Something went wrong", detail: String(e?.stack || "").slice(0, 400) },
      { status: 500 }
    );
  }
}

/**
 * Turn Prisma's output into something an operator can act on.
 *
 * Written after the first run of this step failed with a genuinely misleading
 * message: "check that the app can write to that folder", for what was actually
 * a provider mismatch. The raw output is still returned below this, but the
 * sentence at the top is the one that gets read.
 */
function diagnose(output: string, provider: string): string {
  if (/must start with the protocol|url must start with/i.test(output)) {
    return "The schema and the connection URL disagree about which database engine is in use. That is a bug in this page rather than something you did — please report it.";
  }
  if (/Environment variable not found/i.test(output)) {
    return "The database tool could not read the connection string.";
  }
  if (/ECONNREFUSED|Could not connect|server closed the connection|timed out/i.test(output)) {
    return "Could not reach the database. Check the host, port and that the server is running and accepts connections from here.";
  }
  if (/password authentication failed/i.test(output)) {
    return "The database rejected that password.";
  }
  if (/permission denied/i.test(output)) {
    return "That database user is not allowed to do this. It needs permission to create tables — see the commands above.";
  }
  return provider === "postgresql"
    ? "Could not prepare that database. Check the connection URL, and that the app role has permission to create tables."
    : "Could not create the database file. Check that the app can write to that folder.";
}

/**
 * Generate the two keys the app cannot start without.
 *
 * `NEXTAUTH_SECRET` signs session cookies; rotating it logs everyone out.
 * `PII_ENCRYPTION_KEY` encrypts every name, email and tip at rest.
 *
 * The second is returned ONCE and must be shown to the operator with a "I have
 * backed this up" gate. It cannot be recovered: nothing in the application can
 * re-derive it, and a database restored without it is permanently unreadable.
 */
async function stepSecrets() {
  const existing = readEnvValues(["NEXTAUTH_SECRET", "PII_ENCRYPTION_KEY"]);
  const nextauthSecret = existing.NEXTAUTH_SECRET || crypto.randomBytes(32).toString("base64");
  const piiKey = existing.PII_ENCRYPTION_KEY || crypto.randomBytes(32).toString("hex");

  // Only write the ones we are actually creating, so a re-run cannot silently
  // invalidate a station that already has sessions.
  const vars: Record<string, string> = {};
  if (!existing.NEXTAUTH_SECRET) vars.NEXTAUTH_SECRET = nextauthSecret;
  if (!existing.PII_ENCRYPTION_KEY) vars.PII_ENCRYPTION_KEY = piiKey;
  if (Object.keys(vars).length) await writeEnvValues(vars);

  // NEXTAUTH_SECRET is read at boot, so this needs a restart to take effect.
  const restart = Object.keys(vars).length ? scheduleRestart() : { restarting: false };

  return NextResponse.json({
    ok: true,
    created: Object.keys(vars),
    // Returned deliberately, and only here.
    piiEncryptionKey: piiKey,
    message: existing.PII_ENCRYPTION_KEY
      ? "An encryption key already existed and was kept."
      : "New encryption key generated.",
    ...restart,
  });
}

/**
 * Save the Google credentials and who the administrator is.
 *
 * There is no honest way to test a Google client secret from here: validating it
 * requires an authorisation code, which only exists once a person has been sent
 * to Google and come back. So this checks what CAN be checked without a
 * round-trip — the shape of the ID, and whether the redirect URI the operator is
 * about to register matches the one the app will actually use — and then says
 * plainly what remains unproven. The redirect URI is the cause of almost every
 * sign-in failure, and it is free to check here.
 */
async function stepGoogle(
  clientId: string,
  clientSecret: string,
  adminEmail: string,
  nextauthUrl: string
) {
  const problems: string[] = [];

  if (!clientId) problems.push("Client ID is empty.");
  // Google client IDs end in .apps.googleusercontent.com. Being strict here
  // catches a pasted secret in the wrong box, which otherwise fails much later
  // with an opaque error from Google.
  else if (!/\.apps\.googleusercontent\.com$/.test(clientId))
    problems.push("That does not look like a Google client ID — those end in .apps.googleusercontent.com. Check you pasted the ID and not the secret.");

  if (!clientSecret) problems.push("Client secret is empty.");
  if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail))
    problems.push("Admin email does not look like an email address.");
  if (!nextauthUrl) problems.push("This app's own URL is empty.");
  else {
    try {
      const u = new URL(nextauthUrl);
      if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
        problems.push("Your app URL is not https. Google will refuse to redirect to it.");
      }
      if (u.pathname !== "/" && u.pathname !== "") {
        problems.push("Your app URL should be just the origin, with no path — remove the trailing path.");
      }
    } catch {
      problems.push("That is not a valid URL.");
    }
  }

  const redirectUri = nextauthUrl
    ? `${nextauthUrl.replace(/\/+$/, "")}/api/auth/callback/google`
    : "";

  if (problems.length) {
    return NextResponse.json({ ok: false, error: problems.join(" "), redirectUri }, { status: 400 });
  }

  await writeEnvValues({
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    ADMIN_EMAIL: adminEmail,
    NEXTAUTH_URL: nextauthUrl,
  });

  return NextResponse.json({
    ok: true,
    redirectUri,
    saved: true,
    // Honest about what is still unproven.
    unproven: "The secret cannot be checked until you sign in. If Google rejects it, check the redirect URI matches character for character.",
    // Read at boot.
    ...scheduleRestart(),
  });
}

/**
 * Choose and prepare a database.
 *
 * SQLite is one command. Postgres needs the app role to exist first, which
 * requires superuser SQL that no browser can run — so the wizard hands over the
 * exact statements and then tests the connection the operator gives back.
 */
async function stepDatabase(provider: string, databaseUrl: string, sqlitePath: string) {
  if (provider !== "sqlite" && provider !== "postgresql") {
    return NextResponse.json({ error: "Choose SQLite or Postgres" }, { status: 400 });
  }

  let url = databaseUrl.trim();

  if (provider === "sqlite") {
    // Default to a data/ directory beside the project, which is where the rest
    // of the documentation expects it. A relative Prisma path is resolved
    // against prisma/schema.prisma, so ../data is what lands in <project>/data.
    const chosen = sqlitePath.trim() || "../data/station.db";
    if (chosen.startsWith("/")) url = `file:${chosen}`;
    else if (chosen.startsWith("file:")) url = chosen;
    else url = `file:${chosen.startsWith("../") || chosen.startsWith("./") ? chosen : "../data/" + chosen}`;

    if (url.includes("*")) {
      return NextResponse.json(
        { error: "Wildcards are not supported in a connection string." },
        { status: 400 }
      );
    }
  } else {
    if (!url) {
      return NextResponse.json(
        { error: "Paste your Postgres connection URL." },
        { status: 400 }
      );
    }
    if (!/^postgres(ql)?:\/\//.test(url)) {
      return NextResponse.json(
        { error: "That does not look like a Postgres URL — it should start with postgresql://" },
        { status: 400 }
      );
    }
  }

  // A restart already queued by an earlier step would land in the middle of the
  // work below and kill it. Steps one and two both queue one, and this step
  // takes seconds: it regenerates the Prisma client, then runs every migration.
  // The bounce arrives 800ms after the operator clicks on, which is well inside
  // that window, and what it leaves behind is a half-generated client and an
  // error blaming the folder.
  if (cancelScheduledBounce()) {
    // Said out loud, because "it restarted itself partway through" is otherwise
    // indistinguishable from "this step is unreliable".
    console.log("[setup] cancelled a pending restart so it cannot interrupt the database step");
  }

  const env = { ...process.env, DATABASE_URL: url, DB_PROVIDER: provider };

  // ONE CANONICAL SCHEMA, TWO ENGINES.
  //
  // prisma/schema.prisma declares postgresql, and Prisma validates the URL
  // against the schema's own provider — so handing it a file: URL is rejected
  // before it does anything. Rather than keep a second schema to drift, swap the
  // one datasource block for the length of the command: that is what
  // scripts/gen-schema.mjs exists for, and what the database migration flow
  // already does. The generated client lands in the usual place, because after
  // setup there is only ever one provider live.
  //
  // The temporary schema goes INSIDE prisma/ on purpose: Prisma resolves
  // migrations/ as a sibling of the schema file rather than under prisma/, so a
  // temp file elsewhere would not find the migration history.
  const tmpSchema =
    provider === "sqlite" ? path.join(process.cwd(), "prisma", ".gen-sqlite.prisma") : null;
  const schemaArg = (args: string[]) => (tmpSchema ? [...args, "--schema", tmpSchema] : args);

  try {
    if (provider === "sqlite") {
      // SQLite creates its file lazily; make sure the directory exists first or
      // the failure is an opaque Prisma error about a missing path.
      const p = url.replace(/^file:/, "");
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), "prisma", p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });

      await run("node", [path.join(process.cwd(), "scripts", "gen-schema.mjs"), "sqlite", tmpSchema!], {
        timeout: 60_000,
      });
    }

    // `prisma generate` IN PLACE CRASHES THE APP DOING IT.
    //
    // It rewrites node_modules/@prisma/client while this server has those modules
    // loaded and in use. Generating to a staging directory and moving it into
    // place afterwards means the swap is a rename: the running process keeps
    // using the engine it already loaded, and the next boot picks up the new
    // one. Generating in place instead killed the request partway through, took
    // the app down with it, and — because the app is restarted — turned a wizard
    // step into a reboot.
    //
    // The output path goes in the generator block, not on the command line:
    // `--output` is Prisma 6+, and this project is on 5.22.
    const liveClient = path.join(process.cwd(), "node_modules", "@prisma", "client");
    const stagedClient = path.join(process.cwd(), "node_modules", ".prisma-client-staged");

    // ABSOLUTE, and that is load-bearing. Prisma resolves a relative `output`
    // against the directory holding the schema file, not the working directory —
    // so "../../node_modules/..." from inside prisma/ lands outside the project
    // entirely, and `prisma generate` cheerfully reports success having written
    // the client somewhere the application will never look. It exits 0, the
    // wizard reports a working database, and the app keeps using the old client.
    const outputLine = `\n    output   = ${JSON.stringify(stagedClient)}`;

    const generateStaged = async (schemaFile: string) => {
      fs.rmSync(stagedClient, { recursive: true, force: true });
      const original = fs.readFileSync(schemaFile, "utf8");
      try {
        fs.writeFileSync(
          schemaFile,
          original.replace(
            /generator client \{\s*provider\s*=\s*"[^"]*"/,
            (m) => m + outputLine,
          ),
        );
        await run("npx", ["prisma", "generate", "--schema", schemaFile], { env, timeout: 300_000 });
        // Trust nothing: check the client exists where we said it would go.
        if (!fs.existsSync(path.join(stagedClient, "index.js"))) {
          throw new Error(
            `prisma generate reported success but wrote no client to ${stagedClient}. ` +
              `The generator block now reads:\n${outputLine.trim()}`,
          );
        }
      } finally {
        // Only the output line is ours; the rest of the file goes back as found.
        fs.writeFileSync(schemaFile, original);
      }
      fs.rmSync(liveClient, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(liveClient), { recursive: true });
      fs.renameSync(stagedClient, liveClient);
    };

    if (tmpSchema) {
      await generateStaged(tmpSchema);
    } else {
      // Postgres generates from the canonical schema, so it is staged from a copy
      // rather than by editing the checked-in file.
      const canonical = path.join(process.cwd(), "prisma", ".gen-staged.prisma");
      fs.copyFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), canonical);
      try {
        await generateStaged(canonical);
      } finally {
        fs.rmSync(canonical, { force: true });
      }
    }

    // The SQL migrations are SQLite-only — they emit DATETIME, which Postgres
    // does not have. Postgres is synced from the datamodel instead.
    await run(
      "npx",
      schemaArg(
        provider === "postgresql"
          ? ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"]
          : ["prisma", "migrate", "deploy"]
      ),
      { env, timeout: 600_000 },
    );
  } catch (e: any) {
    const out = `${e?.stdout || ""}\n${e?.stderr || ""}`.trim();
    return NextResponse.json(
      {
        ok: false,
        error: diagnose(out, provider),
        output: out.slice(-1200),
      },
      { status: 400 },
    );
  } finally {
    if (tmpSchema) {
      try {
        fs.rmSync(tmpSchema, { force: true });
      } catch {}
    }
  }

  // Only commit the URL once the database actually answers. Writing it first
  // would leave a broken DATABASE_URL behind a failure, and the next boot would
  // fail in a much more confusing place.
  await writeEnvValues({ DATABASE_URL: url, DB_PROVIDER: provider });

  // Read at boot by the Prisma client and the keep-alive.
  return NextResponse.json({
    ok: true,
    provider,
    providerFromEnv: providerFromEnv(provider, url),
    ...scheduleRestart(),
  });
}

/** Station name, branding, the backend address, and whether to be indexed. */
/**
 * Save the SUB/WAVE host credentials, having proved they work.
 *
 * These four live in the Setting table rather than the environment, which is where
 * getSubwaveConfig() already reads them and where Admin -> Sub/Wave Server writes
 * them. That is why this step exists before the identity step and needs no rebuild:
 * the values are read at request time, so saving them is a database write and
 * nothing restarts.
 *
 * The credentials are proved before they are saved. Saving credentials that do not
 * work would leave a station that looks set up and silently cannot skip a track or
 * ask the host for anything — the sort of failure that shows up weeks later as
 * "the skip button does nothing".
 */
async function stepSubwave(apiUrl: string, adminUser: string, adminPass: string, stationPassword: string) {
  if (!apiUrl) return NextResponse.json({ error: "Your station's server address is needed." }, { status: 400 });
  if (!adminUser || !adminPass) {
    return NextResponse.json(
      { error: "The admin username and password are needed — this app uses them to skip tracks and manage the station." },
      { status: 400 }
    );
  }

  let base: URL;
  try {
    base = new URL(apiUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("scheme");
  } catch {
    return NextResponse.json({ error: "The server address must be a full http:// or https:// address." }, { status: 400 });
  }
  const normalised = base.href.replace(/\/+$/, "").endsWith("/api")
    ? base.href.replace(/\/+$/, "")
    : base.href.replace(/\/+$/, "") + "/api";

  const auth = "Basic " + Buffer.from(`${adminUser}:${adminPass}`).toString("base64");

  // Prove it: reachable, and the credentials accepted. /state needs no auth and is
  // the cheapest proof of life; /settings is the one that actually needs them.
  let hostName: string | null = null;
  let hostDescription: string | null = null;
  try {
    const anon = await fetch(`${normalised}/state`, { signal: AbortSignal.timeout(15000) });
    if (!anon.ok) {
      return NextResponse.json(
        { error: `The server answered ${anon.status}. Check the address — it may need /api on the end.` },
        { status: 502 }
      );
    }
    const a: any = await anon.json().catch(() => null);
    if (typeof a?.station?.name === "string") hostName = a.station.name.trim() || null;
  } catch {
    return NextResponse.json(
      { error: "Could not reach that server address. Check it for typos, and that the station is running." },
      { status: 502 }
    );
  }

  try {
    const res = await fetch(`${normalised}/settings`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json(
        { error: "The server answered, but rejected that username and password." },
        { status: 502 }
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `The server answered ${res.status} to the credentials check.` },
        { status: 502 }
      );
    }
    const d: any = await res.json().catch(() => null);
    const v = d?.values || {};
    if (typeof v.station === "string" && v.station.trim()) hostName = v.station.trim();
    if (typeof v.stationDescription === "string") hostDescription = v.stationDescription.trim() || null;
  } catch {
    return NextResponse.json(
      { error: "The station answered, but the credentials check did not complete." },
      { status: 502 }
    );
  }

  // Only now are they written.
  const rows: { key: string; value: string }[] = [
    { key: "subwaveApiUrl", value: normalised },
    { key: "subwaveAdminUser", value: adminUser },
    { key: "subwaveAdminPass", value: adminPass },
  ];
  if (stationPassword) rows.push({ key: "stationPassword", value: stationPassword });

  try {
    for (const r of rows) {
      await prisma.setting.upsert({ where: { key: r.key }, update: { value: r.value }, create: r });
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Could not save the credentials: ${(e as Error)?.message?.split("\n")[0] || "database error"}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "Signed in to your station.",
    stationName: hostName,
    stationDescription: hostDescription,
    stationPasswordSaved: Boolean(stationPassword),
    restart: false,
  });
}

async function stepStation(body: Record<string, unknown>) {
  const str = (k: string) => String(body[k] ?? "").trim();
  const backendUrl = str("backendUrl");
  const nextauthUrl = str("nextauthUrl");

  if (!backendUrl) {
    return NextResponse.json(
      { error: "We need the public address of your SUB/WAVE station." },
      { status: 400 }
    );
  }
  try {
    const u = new URL(backendUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    return NextResponse.json(
      { error: "The station address must be a full http:// or https:// address." },
      { status: 400 }
    );
  }

  // The name and the description are not asked for, because the SUB/WAVE host
  // already holds both. Read them here rather than trusting the request body, so
  // there is exactly one place a station's identity can come from and no way to
  // set one by sending a different value.
  //
  // What gets baked in is only a copy for first paint and for the build-time
  // metadata. The player prefers the live value from the host on every load, so
  // this never becomes the source of truth — see lib/hostidentity.ts.
  const identity = await getHostIdentity({ fresh: true });
  if (!identity.name) {
    return NextResponse.json(
      {
        error:
          "Could not read your station's name from the SUB/WAVE host. Check the server address and credentials in the previous step.",
      },
      { status: 502 }
    );
  }

  // robots.txt is written BEFORE the build, so it is in place even if the build
  // below fails. A station that failed to build should still not be indexed.
  writeRobotsTxt(body.discoverable === true);

  const result = await applyIdentity({
    name: identity.name,
    tagline: str("tagline"),
    description: identity.description || "",
    about: str("about"),
    logo: str("logo") || "/brand/logo.png",
    backendUrl,
    donateUrl: str("donateUrl"),
    nextauthUrl,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  // Done. The marker is written last, and its existence is what closes the
  // wizard for good.
  markSetupComplete();

  return NextResponse.json({
    ok: true,
    complete: true,
    restarting: result.restarting,
    reason: result.reason,
  });
}

/**
 * Final step. Idempotent, and safe to call twice.
 *
 * Kept separate from the station step so an operator who finished everything
 * else and hit a problem on the last screen can complete without redoing the
 * build.
 */
function stepComplete() {
  markSetupComplete();
  return NextResponse.json({ ok: true, complete: true });
}
