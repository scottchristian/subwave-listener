import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Serves the firmware source tree (minus the multi-gigabyte build cache) as a
// tarball. The build runs on the operator's machine because the VPS has neither
// the toolchain nor the RAM for an ESP-IDF build, so the source has to get to
// them somehow. A single YAML file is not enough: it pulls in `../common/...`
// and `subwave_display/...`, so the whole tree has to travel together.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) return new Response("Forbidden", { status: 403 });

  try {
    const { stdout } = await run(
      "tar",
      ["-czf", "-", "--exclude=.esphome", "-C", process.cwd(), "device/firmware"],
      { encoding: "buffer" }
    );
    return new NextResponse(stdout, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="subwave-firmware-source.tar.gz"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: "Could not package the firmware source." }, { status: 500 });
  }
}
