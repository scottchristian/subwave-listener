import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { verifyCopy } from "@/lib/dbmigrate";
import { providerFromEnv, otherProvider } from "@/lib/db-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Prove the source and target hold identical data, without copying.
 *
 * A separate, visible step rather than a flag the copy sets. `copyDatabase` does
 * verify as it goes, but that is a snapshot taken at the moment the copy ends;
 * this re-reads both sides afterwards, so it also catches anything that changed
 * in between — a listener signing up, a request landing, a DJ starting a stream.
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let targetUrl = "";
  try {
    const body = await req.json();
    targetUrl = String(body?.targetUrl || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!targetUrl) {
    return NextResponse.json({ error: "targetUrl is required" }, { status: 400 });
  }

  const sourceProvider = providerFromEnv();
  const targetProvider = otherProvider(sourceProvider);
  const expected =
    targetProvider === "postgresql" ? /^postgres(ql)?:\/\//i : /^file:/i;
  if (!expected.test(targetUrl)) {
    return NextResponse.json(
      { error: `That target does not look like a ${targetProvider} URL.` },
      { status: 400 }
    );
  }

  const result = await verifyCopy({
    sourceProvider,
    sourceUrl: process.env.DATABASE_URL || "",
    targetProvider,
    targetUrl,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}