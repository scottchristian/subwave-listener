import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";
import prisma from "@/lib/prisma";
import { STATION } from "@/lib/station";
import { parseSkipVisibility } from "@/lib/skipvisibility";
import { parseStillListening, STILL_LISTENING_KEYS } from "@/lib/still-listening";

export async function GET() {
  try {
    const rows = await prisma.setting.findMany({
      where: {
        key: {
          in: [
            "donate_url", "donate_text", "donate_enabled", "streamMode",
            "stationPassword", "maintenanceMode", "maintenanceMessage",
            "verboseLogging", "explicitSuffix", "skipVisibility",
            "headerListeners", "headerWeather", "headerVibe",
            STILL_LISTENING_KEYS.enabled, STILL_LISTENING_KEYS.minutes, STILL_LISTENING_KEYS.reminder,
          ],
        },
      },
    });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    // Station password only rides along for approved sessions — direct mode
    // embeds it in the audio URL, and it must never leak to strangers.
    let stationPassword: string | undefined;
    let clockHour12: boolean | null = null;
    try {
      const session = await getServerSession(authOptions);
      if (session?.user?.email) {
        const user = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (user?.isApproved) stationPassword = get("stationPassword") || undefined;
        const userId = (session?.user as any)?.id;
        if (userId) {
          try {
            const clockRow = await prisma.setting.findUnique({ where: { key: `clockHour12:${userId}` } });
            if (clockRow?.value === "true") clockHour12 = true;
            else if (clockRow?.value === "false") clockHour12 = false;
          } catch {}
        }
      }
    } catch {}
    // Mirror maintenance state locally on every successful read, so the answer
    // survives the database being unreachable. Written here as well as on save
    // because this route already has the value, and it repairs a mirror that
    // was deleted out from under us without waiting for an admin action.
    await mirrorMaintenance({
      maintenanceMode: get("maintenanceMode") === "true",
      maintenanceMessage: get("maintenanceMessage") || "",
    });
    return NextResponse.json({
      donate_url: get("donate_url") || STATION.donateUrl,
      donate_text: get("donate_text") || undefined,
      donate_enabled: (get("donate_enabled") ?? "true") !== "false",
      streamMode: get("streamMode") === "direct" ? "direct" : "relay",
      maintenanceMode: get("maintenanceMode") === "true",
      maintenanceMessage: get("maintenanceMessage") || "",
      verboseLogging: (get("verboseLogging") ?? "true") !== "false",
      explicitSuffix: (get("explicitSuffix") ?? "true") !== "false",
        // Who gets the Skip button. Not sensitive — but this route is behind
        // the session gate, so only signed-in listeners can read it anyway.
        skipVisibility: parseSkipVisibility(get("skipVisibility")),
        // The three header chips. Not sensitive. Default ON, because a station
        // that has never been near these toggles must look exactly as it did
        // before they existed; an operator turns them off deliberately.
      headerListeners: (get("headerListeners") ?? "true") !== "false",
      headerWeather: (get("headerWeather") ?? "true") !== "false",
      headerVibe: (get("headerVibe") ?? "true") !== "false",
      clockHour12,
      stillListening: parseStillListening({
        enabled: get(STILL_LISTENING_KEYS.enabled),
        minutes: get(STILL_LISTENING_KEYS.minutes),
        reminderMinutes: get(STILL_LISTENING_KEYS.reminder),
      }),
      ...(stationPassword ? { stationPassword } : {}),
    });
  } catch (error) {
    // The database is unreachable. That is the one situation maintenance mode
    // exists for, and this catch block used to answer without a
    // `maintenanceMode` key at all — so the player read "off" and the station
    // carried on as if nothing were happening. Answer from the local mirror.
    //
    // If there is no mirror either — cache deleted, or maintenance never saved
    // since this was added — the keys stay absent, exactly as before. Not
    // inventing a value here: defaulting to "on" would take the station dark
    // on a momentary blip, which is a worse failure than the one being fixed.
    const cached = await cachedMaintenance();
    return NextResponse.json({
      donate_url: STATION.donateUrl,
      donate_enabled: true,
      streamMode: "relay",
      headerListeners: true,
      headerWeather: true,
      headerVibe: true,
      ...cached,
    });
  }
}

/**
 * Push the current maintenance state into the local SQLite mirror.
 *
 * Best effort and never throws: this sits on the success path of a route that
 * must keep answering, and a broken mirror must not be able to fail a read that
 * Postgres already served correctly.
 */
async function mirrorMaintenance(state: { maintenanceMode: boolean; maintenanceMessage: string }): Promise<void> {
  try {
    const { litePutSettings } = await import("@/lib/lite-cache");
    await litePutSettings({
      maintenanceMode: state.maintenanceMode ? "true" : "false",
      maintenanceMessage: state.maintenanceMessage,
    });
  } catch {}
}

/** The mirrored maintenance state, as the two keys the client reads. */
async function cachedMaintenance(): Promise<{ maintenanceMode?: boolean; maintenanceMessage?: string }> {
  try {
    const { liteGetSettings } = await import("@/lib/lite-cache");
    const rows = await liteGetSettings();
    const out: { maintenanceMode?: boolean; maintenanceMessage?: string } = {};
    // Absent means "we do not know" and stays absent — see the catch block.
    if (typeof rows.maintenanceMode === "string") out.maintenanceMode = rows.maintenanceMode === "true";
    if (typeof rows.maintenanceMessage === "string") out.maintenanceMessage = rows.maintenanceMessage;
    return out;
  } catch {
    return {};
  }
}
