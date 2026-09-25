import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

// Sanity-check Google OAuth config without starting a login: ID shape,
// secret presence, and the exact redirect URI Google must have registered.
// Read-only.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as any)?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { clientId?: unknown; clientSecret?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = String(body.clientSecret ?? "").trim();
  if (!clientId || !/\.apps\.googleusercontent\.com$/.test(clientId)) {
    return NextResponse.json(
      { error: "Client ID doesn't look like one (must end .apps.googleusercontent.com)" },
      { status: 400 }
    );
  }
  if (!clientSecret) {
    return NextResponse.json({ error: "Client secret is empty" }, { status: 400 });
  }
  const appUrl = (process.env.NEXTAUTH_URL || "").replace(/\/+$/, "");
  return NextResponse.json({
    ok: true,
    message: `Shape OK. Google must list this exact redirect URI: ${appUrl}/api/auth/callback/google`,
  });
}
