"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DbDiagnosis } from "./db-diagnosis";
import { presentSigninSurface, type SigninSurface, type StationStatusPayload } from "./station-status";

const POLL_MS = 10_000;

export type StationStatus = {
  surface: SigninSurface;
  /** The degraded reason, when that is what the surface says. */
  diagnosis: DbDiagnosis | null;
  /** Re-poll immediately (a manual "Check again"). */
  refresh: () => void;
};

/**
 * What an unauthenticated surface should show right now. Polls /api/status.
 * A fetch failure keeps the last verdict — a degraded card must not flash
 * the sign-in button back mid-outage — and only a total absence of any
 * verdict fails open to "signin", because a working station with a hidden
 * sign-in button is worse than a broken one with a visible button.
 */
export function useStationStatus(): StationStatus {
  const [payload, setPayload] = useState<StationStatusPayload | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!alive.current) return;
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as StationStatusPayload | null;
          setPayload(body && typeof body === "object" ? body : null);
        }
        // A non-ok response keeps the last payload: mid-deploy 500s must not
        // flash the sign-in button back during a known outage.
      } catch {
        // Same on a dead fetch — keep the last verdict. Fail open to the
        // sign-in button only when there has never been one.
      }
      if (alive.current) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  const refresh = useCallback(() => {
    // Keep the last payload while re-checking: a degraded card that briefly
    // reverts to the sign-in button mid-fetch is exactly the trap this hook
    // exists to avoid.
    setTick((t) => t + 1);
  }, []);

  return {
    surface: presentSigninSurface(payload),
    diagnosis: payload?.diagnosis ?? null,
    refresh,
  };
}
