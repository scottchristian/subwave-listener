// Is this installation finished being set up?
//
// The wizard writes a marker file next to the env file when it completes. It is
// the ONLY thing standing between "nobody has configured this yet" and "the
// internet can rewrite your Google credentials", so it is deliberately boring:
// a file whose existence is the answer, checked on every gated request.
//
// A marker file rather than "are the required env vars present?" because an
// install can be half-configured in a dozen ways, and a check that guesses wrong
// in the permissive direction hands over the station. A file cannot be
// half-written: `markSetupComplete` runs after every value has landed.
//
// The wizard's routes and the /setup page are reachable ONLY while this returns
// false. Once it returns true they do not exist as far as the proxy is
// concerned — see proxy.ts.

import fs from "node:fs";
import path from "node:path";
import { ENV_FILE, updateEnvFile } from "./envfile";

const MARKER = path.join(path.dirname(ENV_FILE), ".setup-complete");

/** Where the wizard lives. Must match the matcher in proxy.ts. */
export const SETUP_PATH = "/setup";
export const SETUP_API = "/api/setup";

export function isSetupComplete(): boolean {
  try {
    return fs.existsSync(MARKER);
  } catch {
    // Unreadable filesystem: assume not set up. The wizard is then reachable,
    // which is the recoverable direction — a completed setup that is briefly
    // unavailable is confusing; an unreachable wizard is a dead end.
    return false;
  }
}

export function markSetupComplete(): void {
  fs.writeFileSync(MARKER, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function markerPath(): string {
  return MARKER;
}

/**
 * Is this request path part of the wizard, and is the wizard still open?
 *
 * Extracted as a pure function so the one decision that matters — whether a
 * request may reach the routes that write Google credentials — can be tested
 * directly instead of being reasoned about. `complete` is passed in rather than
 * read here, so a test can cover both sides without touching the filesystem.
 *
 * The closed case must cover everything. A path that escapes this check is a
 * path to taking the station over.
 */
export function isSetupPath(pathname: string, complete: boolean): boolean {
  if (complete) return false;
  return under(pathname, SETUP_PATH) || under(pathname, SETUP_API);
}

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(base + "/");

/** The real thing: the on-disk marker, plus the path rule above. */
export function isSetupOpenFor(pathname: string): boolean {
  return isSetupPath(pathname, isSetupComplete());
}

/**
 * Does this install already have enough configured to be a working station?
 *
 * THIS EXISTS TO PREVENT A DEPLOYMENT DISASTER. Upgrading an existing station
 * pulls in code that contains a wizard which writes Google credentials — and the
 * wizard is reachable precisely when there is no marker file. An install that was
 * set up before the wizard existed will never have one. Without this check, the
 * upgrade would silently publish an unauthenticated page that can repoint the
 * station at somebody else's Google account and sign in as its administrator.
 *
 * So a station that is already configured marks itself complete on first boot,
 * and the wizard never appears. Only a genuinely fresh install — no secrets, no
 * credentials, no database — is offered the wizard, which is exactly the set of
 * installs that have nothing to lose from it.
 *
 * All three values are required. Any one missing means someone is mid-setup, and
 * mid-setup is precisely when the wizard should be there.
 */
export function looksConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const has = (k: string) => Boolean(String(env[k] ?? "").trim());
  // NEXT_PUBLIC_STATION_NAME is required, and that is the fix for a trap this
  // check used to spring.
  //
  // The operator no longer types a name — it is read from the SUB/WAVE host — but
  // it is still WRITTEN here, so it is still the right tie-breaker. Setup fetches the
  // name from the host and bakes it in as a copy for first paint; the player then
  // prefers the live value from the host. Removing this from the list would restore
  // the lockout described below, because a half-finished install would once again be
  // indistinguishable from one that finished before the wizard existed.
  //
  // Secrets, Google credentials and a database URL are all written by the first
  // three steps, so an install partway through the wizard has all three — the
  // same set as an install that finished before the wizard existed. The two are
  // indistinguishable on those values alone, so the station name was used as the
  // tie-breaker: it is the last thing setup writes, so having it means setup ran
  // to the end.
  //
  // Without it, the failure was silent and total. The database step restarts the
  // app, the app boots, sees the three values, decides it is an old install, and
  // closes its own wizard — while the operator is still on step four with no
  // station name. They were then locked out of the page that names their station,
  // holding a station that answers to "Community Radio", with the only way forward
  // being to find and delete a marker file they have never heard of.
  return (
    has("NEXTAUTH_SECRET") &&
    has("GOOGLE_CLIENT_ID") &&
    has("DATABASE_URL") &&
    has("NEXT_PUBLIC_STATION_NAME")
  );
}

/**
 * Called once at boot. Closes the wizard on any install that predates it.
 * Returns what it decided, so the caller can say so out loud.
 */
export function adoptIfAlreadyConfigured(): "marked" | "already-marked" | "left-open" {
  if (isSetupComplete()) return "already-marked";
  if (!looksConfigured()) return "left-open";
  try {
    markSetupComplete();
    console.log(
      "[setup] this install is already configured, so the setup wizard is now closed. " +
        "Delete the marker file to run it again."
    );
    return "marked";
  } catch (err) {
    // Better to leave the wizard open and complain than to fail silently.
    console.error(
      "[setup] could not close the setup wizard on an already-configured install:",
      err,
    );
    return "left-open";
  }
}

/** Is the app running as root? Warned about, never enforced — see the wizard. */
export function runningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Read values out of the env file without booting anything.
 *
 * The wizard has to run before the app is configured, so it cannot use the
 * app's own config helpers: `lib/subwave` and friends reach for a database that
 * does not exist yet.
 */
export function readEnvValues(keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = "";
  try {
    raw = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return out;
  }
  for (const key of keys) {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, "m"));
    if (!m) continue;
    out[key] = m[1].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Write values into the env file, creating it if this is a fresh checkout.
 *
 * `updateEnvFile` refuses when the file is absent, which is right for the admin
 * routes — they only ever run against a configured install. The wizard is the
 * one place that legitimately meets a missing file.
 */
export async function writeEnvValues(vars: Record<string, string>): Promise<string[]> {
  if (!fs.existsSync(ENV_FILE)) {
    const header =
      "# Created by the setup wizard. Keep this file private: it holds the keys\n" +
      "# that protect your station.\n";
    fs.writeFileSync(ENV_FILE, header, { mode: 0o600 });
  }
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    /* best effort — a filesystem without chmod is not ours to fix here */
  }
  return (await updateEnvFile(vars)).updated;
}

/**
 * Write public/robots.txt.
 *
 * Written to disk rather than served dynamically because that is how every
 * crawler expects to find it, and because a private station wants it to survive
 * a redeploy rather than depend on the app being up.
 *
 * The default is `Disallow: /`. A station behind sign-in and approval has nothing
 * to gain from being indexed, and the only thing a crawler can find there is the
 * name of something the operator would rather not advertise.
 */
export function writeRobotsTxt(discoverable: boolean): void {
  const body = discoverable
    ? "User-agent: *\nAllow: /\n"
    : "User-agent: *\nDisallow: /\n";
  fs.writeFileSync(path.join(process.cwd(), "public", "robots.txt"), body);
}
