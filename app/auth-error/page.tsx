"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

// Seconds between automatic sign-in attempts while the database may be
// waking, and how many before handing control back to the human. Each attempt
// is a normal Google round-trip — success lands on the front page signed in,
// failure lands back here for the next attempt.
const RETRY_EVERY_S = 10;
const MAX_ATTEMPTS = 30;

/**
 * Where failed sign-ins land (see pages.error in the NextAuth options).
 * Two genuinely different failures share this page, and they need different
 * words: a rejected account is about the account, everything else is almost
 * always the free-tier database asleep or paused — which wakes on its own, so
 * the answer is "wait a minute and retry", not a different account.
 */
function AuthErrorBody() {
  const params = useSearchParams();
  const code = params.get("error") || "";
  const denied = code === "AccessDenied";

  // A sleeping database wakes on its own, so retry without being asked.
  // Success leaves this page signed in; failure lands back here and the
  // countdown starts over. Stops after a few minutes with the button left
  // for the human — retrying forever behind their back is not a feature.
  const [attempt, setAttempt] = useState(0);
  const [countdown, setCountdown] = useState(RETRY_EVERY_S);
  const [stopped, setStopped] = useState(false);
  const autoRetry = !denied && !stopped && attempt < MAX_ATTEMPTS;

  useEffect(() => {
    if (!autoRetry) return;
    if (countdown <= 0) {
      setAttempt((a) => a + 1);
      setCountdown(RETRY_EVERY_S);
      signIn("google", { callbackUrl: "/" });
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [autoRetry, countdown]);

  return (
    <main id="main-auth-error" className="container centered-column" style={{ justifyContent: "center" }}>
      <div id="card-auth-error" className="card" style={{ maxWidth: "480px" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>
          {denied ? "That account can't come in" : "The station couldn't sign you in"}
        </h1>
        {denied ? (
          <p id="about-text-denied-error" className="about-text" style={{ marginBottom: "2rem" }}>
            This account is not approved for the station. If you just asked for access, the owner has not reviewed it yet —
            this screen lets you in automatically once approved. Otherwise try the account you were invited with.
          </p>
        ) : (
          <p id="about-text-db-asleep" className="about-text" style={{ marginBottom: "2rem" }}>
            The station database was probably asleep or paused when you tried — it wakes on its own.
            {autoRetry
              ? ` Retrying in ${countdown}s${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}…`
              : " Automatic retries are off — try below, or resume the database in its dashboard if it keeps failing."}
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            id="btn-retry-signin"
            className="primary-btn"
            style={{ width: "auto" }}
            onClick={() => {
              setAttempt(0);
              setCountdown(RETRY_EVERY_S);
              setStopped(false);
              signIn("google", { callbackUrl: "/" });
            }}
          >
            {denied ? "Sign in with Google" : autoRetry ? "Retry now" : "Try again"}
          </button>
          {!denied && autoRetry ? (
            <button
              id="btn-stop-retry"
              className="primary-btn"
              style={{ width: "auto", background: "rgba(255,255,255,0.1)", color: "#fff" }}
              onClick={() => setStopped(true)}
            >
              Stop retrying
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorBody />
    </Suspense>
  );
}
