import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]/route";
import { getHostIdentity } from "@/lib/hostidentity";

// What the SUB/WAVE host says the station is called.
//
// A route rather than a direct call because the admin panel is a client component
// and reading the host means reading the database for its credentials — that code
// cannot be in the browser bundle. The panel only ever displays these values; they
// are not editable anywhere in this app.
//
// The name and description are public information (they are the station's own name
// and share blurb), so the content is not sensitive, but it is operator information
// and there is no reason to serve it to a listener.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const host = await getHostIdentity();
  return NextResponse.json(
    { name: host.name, description: host.description },
    { headers: { "Cache-Control": "private, max-age=60" } }
  );
}
