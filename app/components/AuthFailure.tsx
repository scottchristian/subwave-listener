"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { claimSigninAttempt, isWakingDbError, wakeStationDatabase } from "@/lib/remember-login";

// Seconds between automatic sign-in attempts while the database may be
// waking, and how many before handing control back to the human. Each attempt
// is a normal Google round-trip — success lands on the front page signed in,
// failure lands back here for the next attempt.
const RETRY_EVERY_S = 10;
const MAX_ATTEMPTS = 30;

/**
 * Failed sign-in, in the station's own words. Two genuinely different
 * failures: a rejected account is about approval, everything else here is
 * almost always the free-tier database asleep or paused — which wakes on its
 * own, so the page retries by itself instead of blaming the account.
 *
 * This loop is the station's only bounded recovery path, so nothing else may
 * suppress it. It used to defer to a per-tab "an automatic attempt was already
 * made" flag on the sign-in page — which meant a listener whose courtesy try had
 * failed landed here and then watched a countdown that could never move, with
 * no button of their own either. The sign-in page now releases that flag on the
 * way in; see decideAutoSignIn.
 */
export default function AuthFailure({ code }: { code: string }) {
  const denied = code === "AccessDenied";
  // No code means a plain visit (bookmarked /signin, or the error page with
  // nothing to say) — a clean prompt, never failure copy and never auto-fire.
  const waking = !denied && isWakingDbError(code);

  // A sleeping database wakes on its own, so retry without being asked.
  // Success leaves this page signed in; failure lands back here and the
  // countdown starts over. Stops after a few minutes with the button left
  // for the human — retrying forever behind their back is not a feature.
  const [attempt, setAttempt] = useState(0);
  const [countdown, setCountdown] = useState(RETRY_EVERY_S);
  const [stopped, setStopped] = useState(false);
  const [wakingDb, setWakingDb] = useState(false);
  // True when this tab stood down because another tab already owns the round-trip.
  const [waitingOnOtherTab, setWaitingOnOtherTab] = useState(false);
  const autoRetry = waking && !stopped && attempt < MAX_ATTEMPTS;

  // Wake, then start one OAuth round-trip — but only if this browser has not
  // already got one in flight.
  //
  // The claim is per-BROWSER on purpose. This page is a retry LOOP, so a listener
  // with the error page open in three tabs used to run three loops, each firing
  // signIn() on its own ten-second beat, each overwriting the single OAuth state
  // cookie they all share. Every callback then arrived to a state that no longer
  // existed and NextAuth refused it ("State cookie was missing") — so nobody could
  // sign in at all, against a database that was wide awake. One tab now wins and
  // the others wait their turn.
  const wakeThenSignIn = () => {
    if (!claimSigninAttempt(Date.now(), window.localStorage)) {
      // Another tab owns this round-trip. Say so rather than looking frozen.
      setWaitingOnOtherTab(true);
      return Promise.resolve(false);
    }
    setWaitingOnOtherTab(false);
    setWakingDb(true);
    return wakeStationDatabase()
      .catch(() => false)
      .finally(() => {
        setWakingDb(false);
        void signIn("google", { callbackUrl: "/" });
      });
  };

  useEffect(() => {
    if (!autoRetry) return;
    if (countdown <= 0) {
      setAttempt((a) => a + 1);
      setCountdown(RETRY_EVERY_S);
      void wakeThenSignIn();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
    // wakeThenSignIn closes over nothing that changes between attempts, and
    // re-running on every attempt would double-fire the sign-in it just started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRetry, countdown]);

  const retryNow = () => {
    setAttempt(0);
    setCountdown(RETRY_EVERY_S);
    setStopped(false);
    void wakeThenSignIn();
  };

  return (
    <main id="main-auth-error" className="container centered-column" style={{ justifyContent: "center" }}>
      <div id="card-auth-error" className="card" style={{ maxWidth: "480px" }}>
        <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>
          {denied
            ? "That account can't come in"
            : waking
              ? "Please wait"
              : "Sign in"}
        </h1>
        {denied ? (
          <p id="about-text-denied-error" className="about-text" style={{ marginBottom: "2rem" }}>
            This account is not approved for the station. If you just asked for access, the owner has not reviewed it yet —
            this screen lets you in automatically once approved. Otherwise try the account you were invited with.
          </p>
        ) : waking ? (
          // Deliberately short, and deliberately not a diagnosis. This screen is
          // read by someone who has done nothing wrong, on a phone, while a
          // database they will never see is coming back up. It used to open
          // "The station couldn't sign you in" and then explain which of the
          // station's own moving parts had let them down — two sentences of
          // housekeeping read as an accusation, and nobody who lands here is
          // reading either. So: ask them to wait, say it will be brief, and give
          // up gracefully if it isn't.
          <p id="about-text-db-asleep" className="about-text" style={{ marginBottom: "2rem" }}>
            {wakingDb
              ? "Waking the station up."
              : waitingOnOtherTab
                ? "You're signed in on another tab."
                : autoRetry
                  ? attempt > 0
                    ? `Still trying — next attempt in ${countdown}s.`
                    : "This usually only takes a moment."
                  : "The station isn't waking up. Try again below, or check back a little later."}
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
            {denied || !waking ? "Sign in with Google" : wakingDb ? "Waking the station…" : autoRetry ? "Retry now" : "Try again"}
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
