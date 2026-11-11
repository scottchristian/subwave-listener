"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import AuthFailure from "@/app/components/AuthFailure";
import {
  claimSigninAttempt,
  decideAutoSignIn,
  hasRememberCookie,
  signinAttemptPending,
  wakeStationDatabase,
} from "@/lib/remember-login";

/**
 * The station's sign-in page. NextAuth forces failed sign-ins here (its own
 * allowlist bypasses pages.error for Callback-class errors), so this is both
 * the front door and the failure page — the error code decides which words.
 *
 * A browser that has been here before is signed in without being asked, so that
 * arriving to a sleeping station costs nothing. Exactly one such attempt is
 * spent per tab, and only on a plain visit: once a real error page is reached,
 * AuthFailure's retry loop owns recovery, because that loop is bounded and can
 * be stopped, and this one could not.
 */
function SigninBody() {
  const params = useSearchParams();
  const errorCode = params.get("error") || "";

  useEffect(() => {
    let remembers = false;
    try {
      remembers = hasRememberCookie(document.cookie);
    } catch {
      remembers = false;
    }

    // Browser-wide, not tab-wide: the state cookie these attempts fight over is
    // shared by every tab, so "has an attempt already gone out?" has to be asked
    // of the browser.
    const decision = decideAutoSignIn({
      remembers,
      errorCode,
      alreadyAttempted: signinAttemptPending(Date.now(), window.localStorage),
    });

    if (decision === "leave-to-retry-loop") return;
    if (decision !== "attempt") return;

    // Take the browser-wide claim BEFORE navigating away. This is the only thing
    // standing between a remembered listener with three tabs open and three
    // simultaneous OAuth flows fighting over one state cookie — see
    // claimSigninAttempt. No cleanup function, deliberately: unmounting is what
    // tore down the guard last time and restarted the carousel every lap.
    if (!claimSigninAttempt(Date.now(), window.localStorage)) return;

    // Deliberately not cancellable on unmount. Unmount here means React tearing
    // down (or StrictMode remounting) before the wake came back, and refusing to
    // sign in at that moment would leave a remembered listener staring at a
    // button they never needed to see.
    void wakeStationDatabase().finally(() => {
      void signIn("google", { callbackUrl: "/" });
    });
  }, [errorCode]);

  return <AuthFailure code={errorCode} />;
}

export default function SigninPage() {
  return (
    <Suspense>
      <SigninBody />
    </Suspense>
  );
}
