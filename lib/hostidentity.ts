// Station identity, read from the SUB/WAVE host that owns it.
//
// WHY THIS EXISTS. The station's name and its share description belong to the
// Subwave host — they are set there, in that project's settings, and that host is
// the only place they are edited. This app used to ask the operator to type them
// and bake the answer into the browser bundle, which made two things true at once:
// the two copies could disagree, and changing the name meant editing this app and
// rebuilding it.
//
// So the direction of travel is reversed. Nothing here is ever a source of truth;
// it is a read of somebody else's, cached for the length of a request burst.
//
// The two fields come from different places, which is worth knowing before anyone
// goes looking for them:
//
//   /state    → station.name            — anonymous, so the browser can read it too
//   /settings → values.station,
//               values.stationDescription — needs admin credentials
//
// The share description is metadata and install-prompt copy, which are produced
// server-side, so needing credentials for it costs nothing. The name is read
// anonymously where possible because the client renders it.

import { getSubwaveConfig, subwaveAdminAuth } from "@/lib/subwave";

export type HostIdentity = {
  /** The station's name, or null when the host did not report one. */
  name: string | null;
  /** The station's share description, or null when unset or unreachable. */
  description: string | null;
};

// Cached in module scope, like the update check: a station sits behind one address
// and polls this on a timer, so an uncached read would be a host request per poll.
// Short enough that renaming the station does not need a restart to show up.
const CACHE_MS = 60 * 1000;
let cached: { at: number; value: HostIdentity } | null = null;

const TIMEOUT_MS = 8000;

/** What the host reports, or nulls. Never throws: an unreachable host is not an error. */
export async function getHostIdentity(opts: { fresh?: boolean } = {}): Promise<HostIdentity> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const empty: HostIdentity = { name: null, description: null };
  const cfg = await getSubwaveConfig();
  if (!cfg.apiUrl) return empty;

  let value = empty;

  // The name first, and anonymously: /state needs no credentials, so this still
  // works when admin auth is wrong or has not been set yet — which is exactly when
  // an operator most needs to see that the host is answering.
  try {
    const res = await fetch(`${cfg.apiUrl}/state`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const data: any = await res.json().catch(() => null);
      const name = typeof data?.station?.name === "string" ? data.station.name.trim() : "";
      if (name) value = { ...value, name };
    }
  } catch {
    // fall through to the admin read below
  }

  // The description only exists behind admin auth.
  const auth = subwaveAdminAuth(cfg);
  if (auth) {
    try {
      const res = await fetch(`${cfg.apiUrl}/settings`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        const v = data?.values || {};
        const name = typeof v.station === "string" ? v.station.trim() : "";
        const desc = typeof v.stationDescription === "string" ? v.stationDescription.trim() : "";
        // /settings is the authoritative copy of the name; prefer it over /state.
        value = { name: name || value.name, description: desc || null };
      }
    } catch {
      // keep whatever /state gave us
    }
  }

  cached = { at: Date.now(), value };
  return value;
}

/**
 * The station name, for contexts that need one synchronously and cannot wait —
 * build-time metadata, a User-Agent, a notification body. Falls back to the
 * caller's placeholder rather than to null, because every caller has a
 * neutral name it would otherwise have to invent.
 */
export function placeholderStationName(): string {
  return "Community Radio";
}

/** Test seam: forget the cached read. */
export function resetHostIdentityCache(): void {
  cached = null;
}
