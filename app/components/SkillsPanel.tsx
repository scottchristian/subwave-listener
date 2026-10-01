"use client";

import { useEffect, useRef, useState } from "react";

// Account-menu panel for running Sub/Wave DJ skills.
//
// Opens as an overlay rather than a route so the page's <audio> element stays
// mounted and the stream keeps playing — the same reason Liked Songs is an
// overlay.
//
// Shape follows the Liked Songs roster: one line per skill, title only, and
// selecting one opens it to show the brief and the Run button. One skill open at
// a time, because these are actions on a live broadcast rather than a browsing
// surface.
//
// The run is slow by nature — Sub/Wave blocks until the agent has written a line
// and TTS has rendered and queued it, tens of seconds — so pressing Run only
// queues the request and returns immediately. This then polls a short endpoint
// every couple of seconds; no request is ever held open long enough for a proxy
// timeout to matter. The four real outcomes are reported as they land rather than
// assumed: on air now / queued for the next track / ran but the DJ stayed quiet
// (a success upstream, not a failure) / did not happen. "unknown" is separate
// again — we stopped waiting, and the segment may still have aired.

interface SkillSummary {
  name: string;
  label: string;
  description: string;
}

type RunState = {
  id: string;
  name: string;
  label: string;
  status: "queued" | "running" | "aired" | "deferred" | "quiet" | "failed" | "unknown";
  spoken: string | null;
  reason: string | null;
  error: string | null;
  startedAt?: string | null;
};

/** Poll cadence while a run is outstanding. Short, and every call is sub-second. */
const POLL_MS = 2000;

/** A skill waiting on a yes/no, held outside the list so it can be modal. */
type Confirming = { name: string; label: string } | null;

export default function SkillsPanel() {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/skills", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data?.error || `Could not load skills (${res.status}).`);
          setSkills([]);
          return;
        }
        setSkills(Array.isArray(data?.skills) ? data.skills : []);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load skills.");
          setSkills([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Stop polling if the panel goes away mid-run. The run itself keeps going on
  // the server — closing this only stops us watching it.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const isPending = !!run && (run.status === "queued" || run.status === "running");

  // Elapsed counter, so a long silence reads as "working" rather than "hung".
  useEffect(() => {
    if (!isPending) { setElapsed(0); return; }
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [isPending]);

  // Bring a finished outcome into view — the roster can be long and the run
  // happens wherever it was started from.
  useEffect(() => {
    if (run && !isPending) outcomeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [run, isPending]);

  // Escape backs out of the confirm, matching the overlay's own Close.
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirming(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  const FINISHED: RunState["status"][] = ["aired", "deferred", "quiet", "failed", "unknown"];

  async function poll(id: string) {
    if (!aliveRef.current) return;
    try {
      const res = await fetch(`/api/skills/run?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (!res.ok) {
        // A failed poll is not a failed run — keep trying rather than guessing.
        pollRef.current = setTimeout(() => poll(id), POLL_MS * 2);
        return;
      }
      const data = await res.json();
      if (!aliveRef.current) return;
      const next: RunState = {
        id, name: data.name, label: data.label, status: data.status,
        spoken: data.spoken ?? null, reason: data.reason ?? null, error: data.error ?? null,
        startedAt: data.startedAt ?? null,
      };
      setRun(next);
      if (!FINISHED.includes(next.status)) {
        pollRef.current = setTimeout(() => poll(id), POLL_MS);
      }
    } catch {
      pollRef.current = setTimeout(() => poll(id), POLL_MS * 2);
    }
  }

  async function requestRun(name: string, label: string) {
    setConfirming(null);
    setRun(null);
    try {
      const res = await fetch("/api/skills/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRun({
          id: "", name, label, status: "failed",
          spoken: null, reason: null,
          error: data?.error || `The request was refused (${res.status}).`,
        });
        return;
      }
      // Queued. Show it immediately, then follow it to a real outcome.
      setRun({ id: data.id, name, label, status: "queued", spoken: null, reason: null, error: null });
      poll(data.id);
    } catch {
      setRun({
        id: "", name, label, status: "failed",
        spoken: null, reason: null, error: "Could not reach the player.",
      });
    }
  }

  const busy = isPending;

  return (
    <div>
      <p className="about-text" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
        These are the skills switched on in your Sub/Wave host — enable one there and it
        appears here. Running one puts the DJ on air with live data, not a preview.
      </p>

      {loadError && (
        <p style={{ color: "var(--color-accent-warm)", fontSize: "0.9rem", marginBottom: "0.75rem" }}>{loadError}</p>
      )}

      {skills === null && !loadError && <p className="about-text">Loading skills…</p>}

      {skills !== null && skills.length === 0 && !loadError && (
        <p className="about-text">
          No skills are switched on in the Sub/Wave host, so there is nothing to run yet.
          Enable one there and it will show up here.
        </p>
      )}

      <div style={{ borderTop: "1px solid var(--color-border)" }}>
        {skills?.map((s) => {
          const open = selected === s.name;
          const isRunning = isPending && run?.name === s.name;
          return (
            <div key={s.name} style={{ borderBottom: "1px solid var(--color-border)" }}>
              <button
                id={`skill-row-${s.name}`}
                onClick={() => setSelected(open ? null : s.name)}
                aria-expanded={open}
                aria-controls={`skill-detail-${s.name}`}
                disabled={busy}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0.75rem",
                  alignItems: "center",
                  width: "100%",
                  padding: "0.65rem 0.25rem",
                  background: "transparent",
                  border: "none",
                  cursor: busy ? "default" : "pointer",
                  textAlign: "left",
                  color: "inherit",
                  opacity: busy && !isRunning ? 0.5 : 1,
                }}
              >
                <span style={{ fontWeight: 600, minWidth: 0 }}>{s.label}</span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
                  {isRunning && (
                    <span className="admin-tab-badge">
                      {run!.status === "queued"
                        ? "Queued…"
                        : elapsed < 2
                          ? "Starting…"
                          : `On air… ${elapsed}s`}
                    </span>
                  )}
                  <span
                    aria-hidden="true"
                    style={{
                      color: "var(--color-muted)",
                      fontSize: "0.8rem",
                      transform: open ? "rotate(90deg)" : "none",
                      transition: "transform 0.2s ease",
                    }}
                  >
                    ›
                  </span>
                </span>
              </button>

              {/* 1fr -> 0fr height animation, matching the Liked Songs rows. */}
              <div
                id={`skill-detail-${s.name}`}
                style={{
                  display: "grid",
                  gridTemplateRows: open ? "1fr" : "0fr",
                  transition: "grid-template-rows 0.25s ease",
                  overflow: "hidden",
                }}
              >
                <div style={{ overflow: "hidden" }}>
                  <div style={{ padding: "0.25rem 0.25rem 0.9rem" }}>
                    {s.description && (
                      <p
                        style={{
                          margin: "0 0 0.75rem",
                          fontSize: "0.875rem",
                          lineHeight: 1.55,
                          fontStyle: "italic",
                          color: "var(--color-muted)",
                          whiteSpace: "pre-line",
                        }}
                      >
                        {s.description}
                      </p>
                    )}
                    <button
                      id={`skill-run-${s.name}`}
                      className="primary-btn"
                      disabled={busy}
                      onClick={() => setConfirming({ name: s.name, label: s.label })}
                      style={{ width: "auto", padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                    >
                      Run
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div ref={outcomeRef} style={{ marginTop: "1.25rem" }}>
        {run && (
          <div
            style={{
              border: run.status === "failed" || run.status === "unknown"
                ? "1px solid var(--color-accent-warm)"
                : "1px solid var(--color-border)",
              borderRadius: "12px",
              padding: "0.85rem 1rem",
            }}
          >
            <strong style={{ display: "block", marginBottom: "0.25rem" }}>
              {run.label}
              {" — "}
              {run.status === "queued" && "queued, waiting for the player"}
              {run.status === "running" && "running now…"}
              {run.status === "aired" && "on air now"}
              {run.status === "deferred" && "queued for the next track"}
              {run.status === "quiet" && "ran, but the DJ stayed quiet"}
              {run.status === "failed" && "did not run"}
              {run.status === "unknown" && "no answer from the station"}
            </strong>

            {run.error && (
              <span className="about-text" style={{ fontSize: "0.875rem", display: "block" }}>{run.error}</span>
            )}
            {run.reason && run.status === "quiet" && (
              <span className="about-text" style={{ fontSize: "0.875rem", display: "block" }}>{run.reason}</span>
            )}
            {run.spoken && (
              <blockquote
                style={{
                  margin: run.error || run.reason ? "0.6rem 0 0" : 0,
                  paddingLeft: "0.75rem",
                  borderLeft: "2px solid var(--color-border)",
                  fontSize: "0.9rem",
                  color: "var(--color-text)",
                }}
              >
                {run.spoken}
              </blockquote>
            )}
          </div>
        )}
      </div>

      {confirming && (
        <div
          id="skill-confirm-bg"
          onClick={() => setConfirming(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2100,
            backgroundColor: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            id="skill-confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skill-confirm-title"
            onClick={(e) => e.stopPropagation()}
            className="card overlay-card-enter"
            style={{ maxWidth: "440px", width: "100%" }}
          >
            <h3 id="skill-confirm-title" style={{ marginTop: 0, fontSize: "1.15rem" }}>
              Run {confirming.label}?
            </h3>
            <p style={{ fontSize: "0.925rem", marginBottom: "1rem" }}>
              This goes over the top of what is currently playing and is spoken to
              everyone listening. It cannot be recalled once it airs.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                id="skill-confirm-yes"
                className="primary-btn"
                onClick={() => confirming && requestRun(confirming.name, confirming.label)}
                style={{ width: "auto", padding: "0.5rem 1rem", fontSize: "0.875rem" }}
              >
                Yes, run it
              </button>
              <button
                id="skill-confirm-no"
                className="primary-btn"
                onClick={() => setConfirming(null)}
                style={{
                  width: "auto",
                  padding: "0.5rem 1rem",
                  fontSize: "0.875rem",
                  background: "rgba(255,255,255,0.1)",
                  color: "#fff",
                }}
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}