"use client";

import type { UpdateJob } from "@/lib/update";

/**
 * The update in progress, as a popup like the liked-songs one — same overlay,
 * same card, same Close. An update takes minutes and the page otherwise shows
 * nothing but a one-line log tail, which reads as "nothing happened".
 *
 * Phases are matched from the job log lines (lib/update-run.ts), newest last.
 * A phase counts as done when its line appears OR a later phase's line does —
 * the dependencies phase logs nothing when there is nothing to reinstall, and
 * it must show skipped rather than stuck.
 */
const PHASES: { label: string; detail: string; match: string }[] = [
  { label: "Preflight", detail: "The server can fetch, unpack and build.", match: "preflight passed" },
  { label: "Download", detail: "Release fetched and verified.", match: "downloaded and verified" },
  { label: "Backup", detail: "Settings backed up and proven.", match: "backup validated" },
  { label: "New source", detail: "Files swapped into place.", match: "source updated" },
  { label: "Dependencies", detail: "Reinstalled when the release wants different ones.", match: "dependencies installed" },
  { label: "Database", detail: "Schema synced.", match: "building (minutes)" },
  { label: "Build", detail: "Station rebuilt.", match: "build fresh" },
  { label: "Restart", detail: "Station restarts on the new version.", match: "\0done" },
];

export function phaseStates(job: UpdateJob): ("done" | "current" | "todo" | "failed" | "skipped")[] {
  const lines = job.log.map((l) => l.toLowerCase());
  const hit = (m: string) => lines.some((l) => l.includes(m));
  const isRestart = (i: number) => PHASES[i].match === "\0done";
  const matched = (i: number) => !isRestart(i) && hit(PHASES[i].match);
  // The pipeline is strictly sequential, and only Dependencies can pass
  // silently (it logs nothing when there is nothing to reinstall). So once
  // "source updated" is on record without "dependencies installed", the deps
  // step is over — skipped, not stuck.
  const depsSkipped = (i: number) =>
    PHASES[i].label === "Dependencies" && !hit(PHASES[i].match) && hit("source updated");
  const current =
    job.status === "running" || job.status === "failed"
      ? PHASES.findIndex((_, i) => !isRestart(i) && !matched(i) && !depsSkipped(i))
      : -1;
  return PHASES.map((p, i) => {
    if (isRestart(i)) return job.status === "done" ? "done" : "todo";
    if (matched(i)) return "done";
    if (depsSkipped(i)) return "skipped";
    if (i === current) return job.status === "failed" ? "failed" : "current";
    return "todo";
  });
}

export default function UpdateModal({
  job,
  channel,
  busy,
  onClose,
  onReload,
  onRollback,
}: {
  job: UpdateJob;
  channel: "release" | "main" | "develop";
  busy: boolean;
  onClose: () => void;
  onReload: () => void;
  onRollback: () => void;
}) {
  const running = job.status === "running";
  const states = phaseStates(job);
  const tail = job.log.length ? job.log[job.log.length - 1] : "Starting…";
  const title =
    job.status === "done"
      ? "Update complete"
      : job.status === "failed"
        ? "Update failed"
        : job.status === "rolled-back"
          ? "Rolled back"
          : `Updating to ${channel === "release" ? `v${job.to}` : job.to}`;

  const dot = (s: string) =>
    s === "done"
      ? { background: "var(--color-accent)" }
      : s === "current"
        ? { background: "var(--color-accent-warm)" }
        : s === "failed"
          ? { background: "#d45757" }
          : { background: "rgba(255,255,255,0.18)" };

  return (
    <div
      id="update-overlay-bg"
      onClick={() => { if (!running && job.status !== "done") onClose(); }}
      className="overlay-bg-enter"
      style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.7)", zIndex: 2000, overflowY: "auto", padding: "2rem 1rem" }}
    >
      <div
        id="update-overlay-card"
        onClick={(e) => e.stopPropagation()}
        className="overlay-card-enter"
        style={{ maxWidth: "560px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}
      >
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1.3rem", margin: 0 }}>{title}</h2>
            {job.status !== "done" && !running ? (
              <button id="btn-close-update" onClick={onClose} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
            ) : null}
          </div>

          {job.status === "done" ? (
            <div>
              <p style={{ fontSize: "0.95rem", marginBottom: "1rem" }}>
                The station restarted on <strong>{channel === "release" ? `v${job.to}` : job.to}</strong>.
                Reload this page so what you see matches what is running.
              </p>
              <button id="btn-reload-after-update" className="primary-btn" style={{ width: "auto", padding: "0.55rem 1.25rem" }} onClick={onReload}>
                Reload this page
              </button>
            </div>
          ) : job.status === "failed" ? (
            <div>
              <p style={{ fontSize: "0.95rem", marginBottom: "1rem" }}>
                {job.error || "The update failed."} The station is still on v{job.from}.
              </p>
              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                {job.backupId ? (
                  <button id="btn-rollback-update-modal" className="primary-btn" disabled={busy} onClick={onRollback} style={{ width: "auto", padding: "0.55rem 1.25rem" }}>
                    {busy ? "Starting rollback…" : `Roll back to v${job.from}`}
                  </button>
                ) : null}
              </div>
            </div>
          ) : job.status === "rolled-back" ? (
            <div>
              <p style={{ fontSize: "0.95rem", marginBottom: "0" }}>
                Back on v{job.from}{job.error ? `: ${job.error}` : ""}. Read the release notes before trying again.
              </p>
            </div>
          ) : (
            <div>
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.45rem" }}>
                {PHASES.map((p, i) => (
                  <li key={p.label} style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", fontSize: "0.9rem", opacity: states[i] === "todo" ? 0.55 : 1 }}>
                    <span aria-hidden="true" style={{ width: "0.65rem", height: "0.65rem", borderRadius: "50%", marginTop: "0.35rem", flexShrink: 0, ...dot(states[i]) }} />
                    <span>
                      <strong>{p.label}</strong>
                      <span style={{ color: "var(--color-muted)" }}>
                        {" — "}
                        {states[i] === "current" ? "in progress…" : states[i] === "skipped" ? "not needed" : p.detail}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              <p style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "1rem", marginBottom: "0.25rem" }}>{tail}</p>
              <p style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: 0 }}>
                The station restarts at the finish. Keep this tab open — closing this window does not stop the update.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
