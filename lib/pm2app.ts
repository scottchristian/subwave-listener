import { execFile } from "node:child_process";

/**
 * Where pm2 lives, and what this app's process is called.
 *
 * Three routes restart the station after changing something the running process
 * has already read into memory: saving the auth settings, saving the station
 * identity (which rebuilds), and a database cutover. They each used to spell the
 * answer out for themselves, and two of them defaulted the process name to
 * "station-web" — a name from a different project that does not exist here.
 *
 * The process name is a property of a *deployment*, not of this software, so
 * there is deliberately no default baked in. A hardcoded name is wrong twice
 * over: it goes stale the moment the process is renamed, and it quietly ties
 * general-purpose software to one station.
 *
 * That is why the routes check `pm2AppConfigured()` and refuse *before* touching
 * anything. A missing PM2_APP_NAME used to mean the routes asked pm2 to restart
 * nothing, logged the failure after the response had already gone, and still
 * answered `restarting: true`. Better to stop before the env file is rewritten.
 */

/**
 * The pm2 process to restart. Empty when PM2_APP_NAME is unset — see
 * `pm2AppConfigured`. Callers must not treat empty as a usable name.
 */
export const PM2_APP = process.env.PM2_APP_NAME || "";

/** Absolute path to pm2, so a bare name is not resolved against a minimal PATH. */
export const PM2_BIN = process.env.PM2_BIN || "/usr/bin/pm2";

/** Is the process name actually known? Gate destructive work on this. */
export function pm2AppConfigured(): boolean {
  return Boolean(PM2_APP);
}

/** The error to return when it is not. One sentence, naming the fix. */
export const PM2_APP_UNCONFIGURED =
  "PM2_APP_NAME is not set, so the app cannot restart itself. Set it to this app's pm2 " +
  "process name and reload the environment — refusing rather than reporting a restart " +
  "that would never happen.";

/**
 * A restart that has been asked for but not yet performed.
 *
 * Held here rather than in applyidentity because two callers need it and they
 * must agree: the routes that save settings ask for a restart, and the handover
 * has to be able to call one off. A restart and a handover both intend to
 * replace this process, so only one can win, and the handover must — it is
 * already replacing the process deliberately, with one running as a different
 * user.
 */
let pendingBounce: NodeJS.Timeout | null = null;

/**
 * Restart this app shortly, so the response reaches the client first.
 *
 * In-flight streams reconnect on their own, which is why the delay exists rather
 * than an immediate restart. A second call replaces the first rather than
 * queueing a second restart, so a burst of saves costs one bounce.
 */
export function scheduleBounce(delayMs = 800): void {
  if (pendingBounce) clearTimeout(pendingBounce);
  pendingBounce = setTimeout(() => {
    pendingBounce = null;
    execFile(PM2_BIN, ["restart", PM2_APP], (err) => {
      if (err) console.error("Self-restart failed:", err.message);
    });
  }, delayMs);
}

/**
 * Call off a scheduled restart. True if one was pending.
 *
 * The handover needs this, and the reason is not hypothetical. Its steps are
 * long-running and destructive — a recursive chown over the whole application
 * directory takes seconds and cannot be resumed — and a restart landing in the
 * middle of one kills the child process doing it. The handover then fails having
 * changed the ownership of some files and not others, which is the worst state
 * to leave a station in, and all it can report is that a command was killed.
 *
 * Found by running it: the secrets step schedules a restart, the operator moves
 * on to the handover, and the deferred restart arrives while `chown -R` is
 * halfway through the tree.
 */
export function cancelScheduledBounce(): boolean {
  if (!pendingBounce) return false;
  clearTimeout(pendingBounce);
  pendingBounce = null;
  return true;
}
