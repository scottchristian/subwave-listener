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
 * What an unauthenticated surface should show right now. Polls /api/status;
 * a fetch failure yields "signin" (fail open — see presentSigninSurface), so
 * a status-endpoint hiccup never hides the button on a working station.
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
        } else {
          setPayload(null);
        }
      } catch {
        if (alive.current) setPayload(null);
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
    setPayload(null);
    setTick((t) => t + 1);
  }, []);

  return {
    surface: presentSigninSurface(payload),
    diagnosis: payload?.diagnosis ?? null,
    refresh,
  };
}
