import { NextRequest, NextResponse } from "next/server";
import {
  cancelAttempt,
  getPublishedRelease,
  listActiveAttempts,
  listReleases,
  OtaError,
  publishRelease,
  reconcileStaleAttempts,
  registerSharedRelease,
  withdrawRelease,
} from "@/lib/firmware-ota";
import { requireAdmin } from "@/lib/admin-auth";
import { MAX_FIRMWARE_BYTES } from "@/lib/firmware-upload";

/**
 * Shared (fleet) firmware releases — the admin side.
 *
 * THIS IS NOT THE PER-DEVICE FIRMWARE CONTROL. That one lives at
 * /api/admin/devices/[id]/firmware, stays exactly as it is, and is the USB path:
 * one image with one screen's claim token in it. This one holds ONE image for the
 * whole fleet, uploads it once, and lets screens install it over the air.
 *
 * ADMIN ONLY, for the same reason flashing is: whoever supplies the bytes decides
 * what every screen runs after its next boot. There is no lesser permission.
 *
 * Upload is validate-then-store; publish is the only act that makes a release
 * installable, and it verifies the artifact again first. Withdraw stops offering
 * it but keeps the bytes, because a screen already installing it must still be
 * able to finish.
 */


const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * An OtaError is a refusal the operator can act on; anything else is a bug we do
 * not describe to the caller. Echoing an arbitrary exception message used to leak
 * database paths and internal identifiers into the panel.
 */
function fail(e: unknown) {
  if (e instanceof OtaError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE });
  }
  console.error("[firmware-ota] admin request failed", e);
  return NextResponse.json(
    { error: "The release could not be used. Check the server log." },
    { status: 500, headers: NO_STORE },
  );
}

/** Everything an operator needs: the offer, the catalogue, and what is installing. */
export async function GET() {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  // A screen that went silent mid-install should not sit in "installing" for
  // ever; asking for the panel is a reasonable moment to age those out.
  await reconcileStaleAttempts().catch(() => 0);

  const [published, releases, activeAttempts] = await Promise.all([
    getPublishedRelease(),
    listReleases(100),
    listActiveAttempts(),
  ]);
  return NextResponse.json({ published, releases, activeAttempts }, { headers: NO_STORE });
}

/** Upload and register one release. Nothing is offered until it is published. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  let bytes: Buffer;
  let version: string;
  let filename: string;
  try {
    const form = await req.formData();
    const file = form.get("firmware");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Attach the compiled OTA app image." }, { status: 400, headers: NO_STORE });
    }
    if (file.size > MAX_FIRMWARE_BYTES) {
      return NextResponse.json(
        { error: `That file is over the ${MAX_FIRMWARE_BYTES / 1_000_000}MB upload limit.` },
        { status: 413, headers: NO_STORE },
      );
    }
    version = typeof form.get("version") === "string" ? String(form.get("version")).trim() : "";
    filename = file.name;
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "The upload could not be read." }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await registerSharedRelease({ bytes, version, filename, uploadedById: admin.id });
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: NO_STORE });
  } catch (e) {
    return fail(e);
  }
}

/**
 * publish | withdraw | cancel. Every move is explicit and audited by the row it
 * changes.
 *
 * `cancel` ends a live attempt as failed. It exists because withdrawal is not the
 * same thing: a screen may be pinned to a withdrawn release and cannot finish, or
 * may be wedged at boot, and the screen itself is the only witness. Without this,
 * the only escape was editing the database.
 */
export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send { action, releaseId }." }, { status: 400, headers: NO_STORE });
  }

  const action = body?.action;
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId : "";
  const attemptId = typeof body?.attemptId === "string" ? body.attemptId : "";

  if (action === "cancel") {
    if (!attemptId || attemptId.length > 64) {
      return NextResponse.json(
        { error: 'Send { action: "cancel", attemptId }.' },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      return NextResponse.json({ attempt: await cancelAttempt(attemptId) }, { headers: NO_STORE });
    } catch (e) {
      return fail(e);
    }
  }

  if ((action !== "publish" && action !== "withdraw") || !releaseId || releaseId.length > 64) {
    return NextResponse.json(
      { error: 'Send { action: "publish" | "withdraw", releaseId } or { action: "cancel", attemptId }.' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const release = action === "publish" ? await publishRelease(releaseId) : await withdrawRelease(releaseId);
    return NextResponse.json({ release }, { headers: NO_STORE });
  } catch (e) {
    return fail(e);
  }
}
