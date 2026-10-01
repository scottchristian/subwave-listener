// Serves branding: the station's own artwork if it has any, the shipped
// placeholder if not.
//
// The URL is fixed forever and the resolution happens here, per request. That is
// what lets an upload apply with no rebuild: nothing upstream has to know which
// copy is active, so the stylesheet, the client components and the document head
// can all point at these paths and never be wrong.
//
// See lib/brandpaths.ts for why the operator's copy and the shipped default live
// in different directories.

import { NextResponse } from "next/server";
import { contentTypeFor, resolveBrandAsset } from "@/lib/brandpaths";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ asset: string[] }> },
) {
  const { asset } = await params;
  const name = (asset || []).join("/");

  const found = await resolveBrandAsset(name);
  if (!found) {
    return NextResponse.json({ error: "No such branding asset" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(found.body), {
    headers: {
      "content-type": contentTypeFor(name),
      // Branding changes when an operator uploads, and the filename never does,
      // so the browser must not hold the old artwork. Revalidate every time
      // rather than guess at a max-age the app cannot enforce.
      "cache-control": "public, max-age=0, must-revalidate",
      "x-brand-source": found.source,
    },
  });
}
