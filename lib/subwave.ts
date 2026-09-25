import prisma from "@/lib/prisma";

// Central Sub/Wave backend config for all proxy routes. Admin-editable values
// live in the Setting table (Admin → Sub/Wave Server); env stays as fallback
// so a fresh install works before anything is saved in the UI.
export async function getSubwaveConfig() {
  let settings: { key: string; value: string }[] = [];
  try {
    settings = await prisma.setting.findMany({
      where: {
        key: {
          in: [
            "subwaveApiUrl",
            "subwaveAdminUser",
            "subwaveAdminPass",
            "stationPassword",
            "subwaveStreamUrl",
            "spotifyClientId",
            "spotifyClientSecret",
            "bmacWebhookSecret",
            "vapidPublicKey",
            "vapidPrivateKey",
            "vapidSubject",
          ],
        },
      },
    });
  } catch {
    // DB unreachable — env fallbacks below still let the proxy try.
  }
  const get = (key: string) => settings.find((s) => s.key === key)?.value || "";

  const rawUrl =
    get("subwaveApiUrl") ||
    process.env.SUBWAVE_API_URL ||
    "";
  // Accept the bare host too (…:7700 without /api): Caddy only forwards /api/*
  // to the controller, so a missing suffix would 404 into the web UI.
  const apiUrl = !rawUrl
    ? ""
    : rawUrl.replace(/\/+$/, "").endsWith("/api")
      ? rawUrl.replace(/\/+$/, "")
      : rawUrl.replace(/\/+$/, "") + "/api";
  const adminUser = get("subwaveAdminUser") || process.env.SUBWAVE_ADMIN_USER || "";
  const adminPass = get("subwaveAdminPass") || process.env.SUBWAVE_ADMIN_PASS || "";
  const stationPassword = get("stationPassword") || "";
  const streamUrl = get("subwaveStreamUrl") || process.env.SUBWAVE_STREAM_URL || "";
  const spotifyClientId = get("spotifyClientId") || process.env.SPOTIFY_CLIENT_ID || "";
  const spotifyClientSecret = get("spotifyClientSecret") || process.env.SPOTIFY_CLIENT_SECRET || "";
  const bmacWebhookSecret = get("bmacWebhookSecret") || process.env.BMAC_WEBHOOK_SECRET || "";

  return {
    apiUrl,
    adminUser,
    adminPass,
    stationPassword,
    streamUrl,
    spotifyClientId,
    spotifyClientSecret,
    bmacWebhookSecret,
  };
}

export function subwaveAdminAuth(cfg: { adminUser: string; adminPass: string }): string | null {
  if (!cfg.adminUser || !cfg.adminPass) return null;
  return "Basic " + Buffer.from(`${cfg.adminUser}:${cfg.adminPass}`).toString("base64");
}
