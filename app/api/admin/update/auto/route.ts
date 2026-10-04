import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { AUTO_UPDATE_KEYS, parseTimeOfDay } from "@/lib/auto-update";

/**
 * The automatic-update window. Validated here, not just in the panel: a
 * hand-crafted request must not arm the scheduler with nonsense, because the
 * scheduler trusts these three values outright.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const enabled = body.enabled === true;
  const start = parseTimeOfDay(body.start);
  const end = parseTimeOfDay(body.end);
  if (enabled && (!start || !end)) {
    return NextResponse.json(
      { error: "Enabling needs both a start and an end time (HH:MM)." },
      { status: 400 }
    );
  }
  if (enabled && start === end) {
    return NextResponse.json({ error: "Start and end are the same — the window would never open." }, { status: 400 });
  }

  const saved = {
    enabled,
    start: enabled ? (start as string) : "",
    end: enabled ? (end as string) : "",
  };
  await prisma.setting.upsert({
    where: { key: AUTO_UPDATE_KEYS.enabled },
    update: { value: enabled ? "true" : "false" },
    create: { key: AUTO_UPDATE_KEYS.enabled, value: enabled ? "true" : "false" },
  });
  await prisma.setting.upsert({
    where: { key: AUTO_UPDATE_KEYS.start },
    update: { value: saved.start },
    create: { key: AUTO_UPDATE_KEYS.start, value: saved.start },
  });
  await prisma.setting.upsert({
    where: { key: AUTO_UPDATE_KEYS.end },
    update: { value: saved.end },
    create: { key: AUTO_UPDATE_KEYS.end, value: saved.end },
  });

  // The scheduler reads fresh every tick, so this applies within the minute —
  // no restart, no waiting.
  return NextResponse.json({ ok: true, saved });
}
