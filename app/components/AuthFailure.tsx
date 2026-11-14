"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { claimSigninAttempt, isWakingDbError, wakeStationDatabase } from "@/lib/remember-login";
import { isRetryableDiagnosis, type DbDiagnosis } from "@/lib/db-diagnosis";

// Seconds between automatic sign-in attempts while the database may be
// waking, and how many before handing control back to the human. Each attempt
// is a normal Google round-trip — success lands on the front page signed in,
// failure lands back here for the next attempt.
const RETRY_EVERY_S = 10;
const MAX_ATTEMPTS = 30;

/**
 * Failed sign-in, in the station's own words. Three genuinely different
 * failures: a rejected account is about approval; a sleeping database wakes on
 * its own, so the page retries by itself instead of blaming the account; and a
 * permanent database failure (wrong engine, wrong credentials — the wake
 * endpoint says which) stops the retries and says so, because a countdown
 * against a misconfiguration counts down forever.
 *
 * For everything retryable this loop is the station's only bounded recovery
 * path, so nothing else may suppress it. It used to defer to a per-tab "an
 * automatic attempt was already made" flag on the sign-in page — which meant a
 * listener whose courtesy try had failed landed here and then watched a
 * countdown that could never move, with no button of their own either. The
 * sign-in page now releases that flag on the way in; see decideAutoSignIn.
 * A permanent diagnosis is the one exception: it stops the countdown because
 * nothing the page can do will help, and leaves a manual "Try again" instead.
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
  // 0 so the first wake fires on mount: the diagnosis (if any) shows in
  // seconds instead of after a ten-second countdown.
  const [countdown, setCountdown] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [wakingDb, setWakingDb] = useState(false);
  const [waitingOnOtherTab, setWaitingOnOtherTab] = useState(false);
  // What the wake endpoint actually reported. A permanent failure (wrong
  // database engine, wrong credentials) stops the loop: no number of attempts
  // fixes that, and the copy below says so instead of counting down forever.
  const [diagnosis, setDiagnosis] = useState<DbDiagnosis | null>(null);
  const retryable = isRetryableDiagnosis(diagnosis);
  const autoRetry = waking && retryable && !stopped && attempt < MAX_ATTEMPTS;

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
      .then((r) => {
        setDiagnosis(r.diagnosis);
        // A permanent failure makes the OAuth round-trip pointless — it would
        // land right back here. Say why instead of sending the listener to
        // Google and back to nowhere.
        if (r.diagnosis && !isRetryableDiagnosis(r.diagnosis)) return false;
        void signIn("google", { callbackUrl: "/" });
        return r.woke;
      })
      .catch(() => {
        setDiagnosis(null);
        void signIn("google", { callbackUrl: "/" });
        return false;
      })
      .finally(() => setWakingDb(false));
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
    setDiagnosis(null);
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
              ? retryable
                ? "Please wait"
                : "The station can't reach its database"
              : "Sign in"}
        </h1>
        {denied ? (
          <p id="about-text-denied-error" className="about-text" style={{ marginBottom: "2rem" }}>
            This account is not approved for the station. If you just asked for access, the owner has not reviewed it yet —
            this screen lets you in automatically once approved. Otherwise try the account you were invited with.
          </p>
        ) : waking && !retryable && diagnosis ? (
          // The wake endpoint named a permanent reason. This is the message
          // that turns an outage into a diagnosis: it says what is wrong and
          // that waiting cannot help, instead of a countdown that goes nowhere.
          <p id="about-text-db-diagnosis" className="about-text" style={{ marginBottom: "2rem" }}>
            {diagnosis.summary}
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
