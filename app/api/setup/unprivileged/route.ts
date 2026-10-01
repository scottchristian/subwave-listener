// Offer, and carry out, the handover from root to an unprivileged account.
//
// Separate from /api/setup/apply on purpose. That route writes credentials;
// this one runs root-level commands. Keeping them apart means a change to one is
// obviously not a change to the other, and the gate they share is stated once
// rather than twice by accident.
//
// Public only while setup is unfinished — see proxy.ts. Re-checked here, because
// a gate that exists only in the proxy is one refactor from being bypassed.

import { NextResponse } from "next/server";
import { isSetupComplete, runningAsRoot, markerPath } from "@/lib/setup";
import { handoverPlan, performHandover } from "@/lib/handover";
import { PM2_APP, pm2AppConfigured } from "@/lib/pm2app";
import fs from "node:fs";
import { SERVICE_USER } from "@/lib/handover";

const exists = (p: string) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

function accountExists(): boolean {
  try {
    // getent is the portable answer to "does this user exist" and does not
    // depend on the current uid, which matters because the wizard may be about
    // to create the very account being asked about.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("id", ["-u", SERVICE_USER], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function plan() {
  const p = handoverPlan(
    {
      runningAsRoot: runningAsRoot(),
      pm2Configured: pm2AppConfigured(),
      userExists: accountExists(),
      icecastConfigExists: exists("/etc/icecast2/icecast.xml"),
    },
    PM2_APP,
  );
  return { ...p, runningAsRoot: runningAsRoot(), marker: markerPath() };
}

export async function GET() {
  if (isSetupComplete()) {
    return NextResponse.json({ error: "Setup is already complete" }, { status: 404 });
  }
  return NextResponse.json(plan());
}

export async function POST(req: Request) {
  if (isSetupComplete()) {
    return NextResponse.json({ error: "Setup is already complete" }, { status: 404 });
  }

  let body: { mode?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // A GET-shaped answer to a POST is almost always a confused client or a
  // retry. Re-sending is harmless; doing the handover twice would not be.
  if (body.mode !== "apply") {
    return NextResponse.json(plan());
  }

  const current = plan();
  if (!current.runningAsRoot) {
    return NextResponse.json(
      { error: "This is already running as an unprivileged account. Nothing to do." },
      { status: 400 },
    );
  }
  if (!current.canAutomate) {
    return NextResponse.json(
      {
        error:
          "This application is not managed by pm2, so this page cannot restart it as the new account. Use the commands below instead, then restart setup.",
        plan: current,
      },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await performHandover(PM2_APP);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "The handover failed.", plan: plan() },
      { status: 500 },
    );
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error, plan: plan() }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    handoverStarted: result.handoverStarted,
    output: result.output,
    notes: result.notes,
    revert: result.revert,
  });
}
