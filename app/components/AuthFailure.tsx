"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";

// Seconds between automatic sign-in attempts while the database may be
// waking, and how many before handing control back to the human. Each attempt
// is a normal Google round-trip — success lands on the front page signed in,
// failure lands back here for the next attempt.
const RETRY_EVERY_S = 10;
const MAX_ATTEMPTS = 30;

// Error classes NextAuth forces onto the signin page (its own allowlist
// bypasses pages.error for these), plus the ones pages.error receives.
// Grouped by what the human should hear, not by NextAuth's names.
const WAKING_DB = new Set([
  "Callback",
  "OAuthCallback",
  "OAuthCreateAccount",
  "OAuthSignin",
  "Signin",
  "AdapterError",
  "default",
]);

/**
 * Failed sign-in, in the station's own words. Two genuinely different
 * failures: a rejected account is about approval, everything else here is
 * almost always the free-tier database asleep or paused — which wakes on its
 * own, so the page retries by itself instead of blaming the account.
 */
export default function AuthFailure({ code }: { code: string }) {
  const denied = code === "AccessDenied";
  // No code means a plain visit (bookmarked /signin, or the error page with
  // nothing to say) — a clean prompt, never failure copy and never auto-fire.
  const waking = !denied && WAKING_DB.has(code);

  // A sleeping database wakes on its own, so retry without being asked.
  // Success leaves this page signed in; failure lands back here and the
  // countdown starts over. Stops after a few minutes with the button left
  // for the human — retrying forever behind their back is not a feature.
  const [attempt, setAttempt] = useState(0);
  const [countdown, setCountdown] = useState(RETRY_EVERY_S);
  const [stopped, setStopped] = useState(false);
  const [wakingDb, setWakingDb] = useState(false);
  const autoRetry = waking && !stopped && attempt < MAX_ATTEMPTS;

  const wakeDatabase = async () => {
    setWakingDb(true);
    try {
      await fetch("/api/auth/wake-db", { method: "POST" });
    } catch {
      // Ignore wake errors; the sign-in will fail naturally if it doesn't work
    } finally {
      setWakingDb(false);
    }
  };

  useEffect(() => {
    if (!autoRetry) return;
    if (countdown <= 0) {
      setAttempt((a) => a + 1);
      setCountdown(RETRY_EVERY_S);
      wakeDatabase().then(() => {
        signIn("google", { callbackUrl: "/" });
      });
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [autoRetry, countdown]);

  const retryNow = () => {
    setAttempt(0);
    setCountdown(RETRY_EVERY_S);
    setStopped(false);
    wakeDatabase().then(() => {
      signIn("google", { callbackUrl: "/" });
    });
  };

  return (
    <main id="main-auth-error" className="container centered-column" style={{ justifyContent: "center" }}>
      <div id="card-auth-error" className="card" style={{ maxWidth: "480px" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>
          {denied
            ? "That account can't come in"
            : waking
              ? "The station couldn't sign you in"
              : "Sign in"}
        </h1>
        {denied ? (
          <p id="about-text-denied-error" className="about-text" style={{ marginBottom: "2rem" }}>
            This account is not approved for the station. If you just asked for access, the owner has not reviewed it yet —
            this screen lets you in automatically once approved. Otherwise try the account you were invited with.
          </p>
        ) : waking ? (
          <p id="about-text-db-asleep" className="about-text" style={{ marginBottom: "2rem" }}>
            The station database was probably asleep or paused when you tried.
            {wakingDb
              ? " Waking it up…"
              : autoRetry
                ? ` Retrying in ${countdown}s${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}…`
                : " Automatic retries are off — try below, or resume the database in its dashboard if it keeps failing."}
          </p>
        ) : (
          <p className="about-text" style={{ marginBottom: "2rem" }}>
            Sign in with Google to listen to the station.
          </p>
        )}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            id="btn-retry-signin"
            className="primary-btn"
            style={{ width: "auto" }}
            onClick={denied || !waking ? () => signIn("google", { callbackUrl: "/" }) : retryNow}
            disabled={wakingDb}
          >
            {denied || !waking ? "Sign in with Google" : wakingDb ? "Waking database…" : autoRetry ? "Retry now" : "Try again"}
          </button>
          {waking && autoRetry ? (
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
