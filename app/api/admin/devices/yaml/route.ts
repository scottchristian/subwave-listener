import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { readFile } from "node:fs/promises";
import path from "node:path";

// The firmware YAML is the same for every screen: device_id and claim_token are
// compiled in via `-s` substitutions, so the file itself only carries the
// unprovisioned defaults. It is served here so the operator can download it
// without needing shell access to the server — the build runs on their machine
// because the VPS has neither the toolchain nor the RAM for an ESP-IDF build.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  const file = path.join(process.cwd(), "device", "firmware", "builds", "subwave-jc8012p4a1.yaml");
  try {
    const body = await readFile(file, "utf8");
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": 'attachment; filename="subwave-jc8012p4a1.yaml"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Firmware template not found on the server." }, { status: 404 });
  }
}
