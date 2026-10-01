// Apply the station's identity: write the values, rebuild, restart, and report
// what actually happened.
//
// WHY THIS IS A MODULE AND NOT INLINE. Two callers need it — the admin route
// that handles a station-identity save, and the first-run setup wizard — and the
// part that matters is a five-step sequence with a failure mode at each step.
// Two copies of that would drift, and the drift would show up as "the wizard
// says it rebuilt but the name did not change", which is exactly the kind of
// bug that is hard to see and easy to ship.
//
// WHY A REBUILD AT ALL. Every value here is NEXT_PUBLIC_*, which Next compiles
// into the browser bundle at build time. Restarting the process does not pick up
// a new one — only a rebuild does. That is why this is slow, and it is the
// reason the wizard cannot set a station name without a visible wait.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { writeEnvValues } from "./setup";
import { pm2AppConfigured, scheduleBounce, cancelScheduledBounce } from "./pm2app";

const run = promisify(execFile);
const APP_DIR = process.cwd();

export type IdentityValues = {
  name: string;
  tagline: string;
  description: string;
  about: string;
  logo: string;
  backendUrl: string;
  donateUrl: string;
  nextauthUrl: string;
};

export type ApplyResult =
  | { ok: true; restarting: boolean; reason?: string }
  | { ok: false; error: string; wroteEnv: boolean };

export async function applyIdentity(values: IdentityValues): Promise<ApplyResult> {
  const vars: Record<string, string> = {
    NEXT_PUBLIC_STATION_NAME: values.name,
    NEXT_PUBLIC_STATION_TAGLINE: values.tagline,
    NEXT_PUBLIC_STATION_DESCRIPTION: values.description,
    NEXT_PUBLIC_STATION_ABOUT: values.about,
    NEXT_PUBLIC_STATION_LOGO: values.logo,
    NEXT_PUBLIC_BACKEND_URL: values.backendUrl,
    NEXT_PUBLIC_DONATE_URL: values.donateUrl,
    NEXTAUTH_URL: values.nextauthUrl,
  };

  // A restart queued by whatever the operator did last would land in the middle
  // of the build below and kill it. The wizard queues one at the end of each
  // earlier step, and a build takes tens of seconds, so the bounce arrives
  // comfortably inside that window.
  //
  // The failure this causes is worse than an interrupted request: `next build`
  // clears .next before it starts, so a build killed halfway leaves the station
  // with no build at all. It then crash-loops on "Could not find a production
  // build", which reads as a corrupt installation rather than a race, and the
  // wizard — which is being served by that same application — goes down with it.
  if (cancelScheduledBounce()) {
    console.log("[identity] cancelled a pending restart so it cannot interrupt the build");
  }

  // Written BEFORE the build, because the build reads them. If the build then
  // fails, the env file holds values for a build that never shipped — harmless,
  // and the next build picks them up.
  try {
    await writeEnvValues(vars);
  } catch (e: any) {
    return { ok: false, error: `Could not write ${ENV_LABEL}: ${e?.message || e}`, wroteEnv: false };
  }

  const before = Date.now();
  try {
    // Long, because a cold Next build on a small VPS is not fast.
    await run("npm", ["run", "build"], { cwd: APP_DIR, timeout: 900_000 });
  } catch (e: any) {
    console.error("Identity rebuild failed:", e?.message || e);
    return {
      ok: false,
      error:
        "The build failed, so the old version is still running and nothing has changed. " +
        "Check the server logs — run `npm run build` yourself to see the error.",
      wroteEnv: true,
    };
  }

  // A build can exit 0 and still have produced nothing — a partial write, a disk
  // that filled. Compare the build ID's mtime against when we started, which is
  // the only evidence that new output exists.
  let fresh = false;
  try {
    const st = await stat(`${APP_DIR}/.next/BUILD_ID`);
    fresh = st.mtimeMs > before;
  } catch {}
  if (!fresh) {
    return {
      ok: false,
      error: "The build produced no new output — the old version is still running.",
      wroteEnv: true,
    };
  }

  return { ok: true, ...scheduleRestart() };
}

const ENV_LABEL = ".env.local";

/**
 * Bounce the process, if we know how.
 *
 * There is no default process name anywhere in this software — it belongs to a
 * deployment. On a workstation (`npm run dev`, `npm start`) there is nothing to
 * ask, so the caller is told to restart by hand rather than being told a restart
 * happened when none did. That distinction is the whole reason this returns a
 * reason.
 */
export function scheduleRestart(): { restarting: boolean; reason?: string } {
  if (!pm2AppConfigured()) {
    return {
      restarting: false,
      reason: "PM2_APP_NAME is not set, so the app could not restart itself. Restart it by hand for the new name to take effect.",
    };
  }
  // Answer first, then bounce — in-flight streams reconnect on their own.
  scheduleBounce();
  return { restarting: true };
}
