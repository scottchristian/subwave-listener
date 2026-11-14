/**
 * Whether the station is worth signing into, as a small set of public states.
 *
 * Three states, decided server-side by /api/status and rendered by two
 * client entry points (the /signin card and the home-page sign-in button):
 *
 *   ok       — the database answers; the sign-in button is real.
 *   updating — deploy.sh has written data/maintenance.json; a deploy is
 *              mid-flight and signing in now is exactly how a listener ends
 *              up on a white screen.
 *   degraded — the database answered with a PERMANENT failure (engine
 *              mismatch, missing URL, rejected credentials). A sleeping
 *              database is NOT degraded: it wakes on its own and the sign-in
 *              page's retry loop already says "Please wait" for it.
 *
 * The decision functions are pure so both the route and the check suite can
 * drive them without a database. This module adds no node builtins and no
 * env reads; the client bundle imports it too.
 */

import { isRetryableDiagnosis, type DbDiagnosis } from "./db-diagnosis";

export type StationStatusName = "ok" | "updating" | "degraded";

export type StationStatusPayload = {
  status: StationStatusName;
  /** Public-safe, present only for degraded. */
  diagnosis?: DbDiagnosis | null;
};

/**
 * What an unauthenticated sign-in surface should show. "signin" covers both
 * a proven-ok station and an unreachable /api/status: when the status
 * endpoint itself hiccups, the surfaces must fail OPEN, because a working
 * station with a hidden sign-in button is worse than a broken one with a
 * visible button.
 */
export type SigninSurface = "signin" | "updating" | "degraded";

/** Route-side: fold the maintenance flag and the probe result into a payload. */
export function statusFromProbe(args: {
  maintenanceFlagPresent: boolean;
  woke: boolean;
  diagnosis: DbDiagnosis | null;
}): StationStatusPayload {
  if (args.maintenanceFlagPresent) return { status: "updating" };
  // Only a permanent diagnosis degrades the station. A sleeping/unknown
  // failure is transient — the wake path and the retry loop own that copy.
  if (!args.woke && args.diagnosis && !isRetryableDiagnosis(args.diagnosis)) {
    return { status: "degraded", diagnosis: args.diagnosis };
  }
  return { status: "ok" };
}

/** Client-side: fold a fetched payload (or a fetch failure) into a surface. */
export function presentSigninSurface(payload: StationStatusPayload | null): SigninSurface {
  if (!payload) return "signin";
  if (payload.status === "updating") return "updating";
  if (payload.status === "degraded" && payload.diagnosis && !isRetryableDiagnosis(payload.diagnosis)) {
    return "degraded";
  }
  return "signin";
}
