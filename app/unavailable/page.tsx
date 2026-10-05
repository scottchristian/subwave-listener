"use client";

import { Suspense, useEffect, useState } from "react";

/**
 * The station database is unreachable (asleep, paused, or gone). This page is
 * public and needs no database itself — it is what logged-in users get instead
 * of a sign-in prompt that could never work. It polls for recovery and sends
 * them back to the front page the moment a session answers again.
 */
const POLL_EVERY_MS = 10_000;

function UnavailableBody() {
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json().catch(() => null);
        // Unauthenticated answers {} — only a user object means back.
        if (!stop && d && typeof d === "object" && (d as any).user) {
          window.location.href = "/";
        }
      } catch {
        // Still down — the next poll tries again.
      }
      if (!stop) setAttempt((a) => a + 1);
    };
    check();
    const id = setInterval(check, POLL_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  return (
    <main id="main-unavailable" className="container centered-column" style={{ justifyContent: "center" }}>
      <div id="card-unavailable" className="card" style={{ maxWidth: "480px" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>Station database unreachable</h1>
        <p id="about-text-unavailable" className="about-text" style={{ marginBottom: "2rem" }}>
          The station cannot reach its database — it may be asleep, paused, or gone. Nothing is lost on your end;
          this page checks on its own{attempt > 0 ? ` (check ${attempt + 1})` : ""} and takes you back in when it answers.
        </p>
        <button
          id="btn-unavailable-retry"
          className="primary-btn"
          style={{ width: "auto" }}
          onClick={() => window.location.reload()}
        >
          Check now
        </button>
      </div>
    </main>
  );
}

export default function UnavailablePage() {
  return (
    <Suspense>
      <UnavailableBody />
    </Suspense>
  );
}
