import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { getSubwaveConfig } from "@/lib/subwave";
import prisma from "@/lib/prisma";

/**
 * Donation webhook readiness, for the admin panel.
 *
 * Reports only whether the shared secret is present and where it came from —
 * never the secret itself. Without this the panel would have to show a webhook
 * URL and leave the operator guessing whether anything will actually be
 * accepted, and the first sign of a misconfigured feed would be a donation that
 * silently never appears.
 *
 * The secret can live in the Setting table or, preferably, in server env: it is
 * a credential, and the Setting table is not encrypted at rest.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await getSubwaveConfig();
  let inTable = false;
  try {
    const row = await prisma.setting.findUnique({
      where: { key: "bmacWebhookSecret" },
      select: { value: true },
    });
    inTable = !!(row?.value && row.value.trim().length > 0);
  } catch {
    // Unreadable table is not itself a reason to fail — env may still have it.
    inTable = false;
  }

  const configured = !!(cfg.bmacWebhookSecret && cfg.bmacWebhookSecret.trim().length > 0);

  return NextResponse.json({
    // Only Buy Me A Coffee is wired up. The webhook route verifies an HMAC over
    // the body against a shared secret, which nothing else can produce.
    provider: "bmac",
    providers: ["bmac"],
    endpoint: "/api/webhooks/bmac",
    configured,
    // "table" means the secret is stored unencrypted in the database, which is
    // worth surfacing so it can be moved to env.
    source: configured ? (inTable ? "table" : "env") : null,
  });
}
