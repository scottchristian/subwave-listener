import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { findOfferedSkill } from "@/lib/skillcatalog";
import { enqueueSkillRun } from "@/lib/skillrunner";

export const dynamic = "force-dynamic";

/**
 * Shared gate for both verbs. Returns the user, or a ready-made response.
 */
async function requireSkillUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return { user: null, fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  let user;
  try {
    user = await prisma.user.findUnique({ where: { email: session.user.email } });
  } catch {
    return { user: null, fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!user || !user.isApproved) {
    return { user: null, fail: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!user.isAdmin && !user.canUseSkills) {
    return { user: null, fail: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, fail: null };
}

/**
 * Ask for a skill to run.
 *
 * Returns as soon as the request is durably queued — typically well under a
 * second. The Sub/Wave call itself (45s+ of LLM then TTS) happens in the
 * background worker, so no browser or reverse-proxy timeout is involved and the
 * listener is not left staring at a hung request.
 *
 * Poll GET /api/skills/run?id=… for the outcome.
 */
export async function POST(req: NextRequest) {
  const { user, fail } = await requireSkillUser();
  if (fail) return fail;

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Never forward a caller-supplied string unchecked, and record the
  // operator's own label rather than the slug. Also means a skill switched off
  // or removed upstream stops being runnable immediately, not at the next deploy.
  const skill = await findOfferedSkill(name);
  if (!skill) {
    return NextResponse.json({ error: "That skill is not available." }, { status: 400 });
  }

  // One outstanding run per person. Not a rate limit — a courtesy guard, because
  // the broadcast lane is serial and a double-click would otherwise queue the
  // same segment twice with no way to cancel the second.
  const outstanding = await prisma.skillRun.findFirst({
    where: { userId: user!.id, status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (outstanding) {
    return NextResponse.json(
      { error: "You already have a skill running — give it a moment." },
      { status: 409 }
    );
  }

  const run = await enqueueSkillRun(user!.id, skill.name, skill.label);
  return NextResponse.json(
    { id: run.id, status: run.status, queuedAt: run.queuedAt },
    { status: 202 }
  );
}

/** Poll one run. Scoped to the caller, so an id is not a capability. */
export async function GET(req: NextRequest) {
  const { user, fail } = await requireSkillUser();
  if (fail) return fail;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  const run = await prisma.skillRun.findFirst({ where: { id, userId: user!.id } });
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: run.id,
    name: run.skillName,
    label: run.skillLabel,
    status: run.status,
    spoken: run.spoken,
    reason: run.reason,
    error: run.error,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}