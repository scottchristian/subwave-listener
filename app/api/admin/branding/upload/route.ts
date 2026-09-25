import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth/[...nextauth]/route";
import { applyBrandingUpload } from "@/lib/branding";

// Admin asset upload: logo (also regenerates every icon), standalone icon
// set, or backdrop. Files land in public/ so they serve instantly — no
// rebuild, no restart.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let kind: string | null = null;
  let buf: Buffer | null = null;
  try {
    const form = await req.formData();
    kind = typeof form.get("kind") === "string" ? (form.get("kind") as string) : null;
    const file = form.get("file");
    if (file instanceof Blob) buf = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }
  if (kind !== "logo" && kind !== "icon" && kind !== "background") {
    return NextResponse.json({ error: "kind must be logo, icon or background" }, { status: 400 });
  }
  if (!buf?.length) {
    return NextResponse.json({ error: "No file attached" }, { status: 400 });
  }
  try {
    const written = await applyBrandingUpload(kind, buf);
    return NextResponse.json({ ok: true, written });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Upload failed" }, { status: 400 });
  }
}
