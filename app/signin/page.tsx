"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import AuthFailure from "@/app/components/AuthFailure";
import { decideAutoSignIn, hasRememberCookie, wakeStationDatabase } from "@/lib/remember-login";

/**
 * Per-tab record that the one automatic attempt has been spent.
 *
 * sessionStorage, deliberately: it must SURVIVE the round-trip to Google (the
 * document is torn down and rebuilt, and it is the same tab) and must NOT
 * survive closing the tab. An earlier version deleted this on unmount, which is
 * what turned the courtesy try into an endless carousel — see decideAutoSignIn.
 */
const AUTO_SIGNIN_GUARD = "subwave_auto_signin_attempted";

/** storage can throw in private browsing; none of this is worth a crash over. */
function readGuard(): boolean {
  try {
    return sessionStorage.getItem(AUTO_SIGNIN_GUARD) === "1";
  } catch {
    return false;
  }
}
function setGuard(): void {
  try {
    sessionStorage.setItem(AUTO_SIGNIN_GUARD, "1");
  } catch {
    // Worst case the courtesy try repeats once per page load. Bounded by the
    // fact that a plain visit is a plain visit, not a loop.
  }
}
function clearGuard(): void {
  try {
    sessionStorage.removeItem(AUTO_SIGNIN_GUARD);
  } catch {
    // As above.
  }
}

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

    const decision = decideAutoSignIn({ remembers, errorCode, alreadyAttempted: readGuard() });

    if (decision === "leave-to-retry-loop") {
      // Getting here means the automatic path did not work. Release the guard so
      // AuthFailure's loop is not gagged by it, and let it take over.
      clearGuard();
      return;
    }
    if (decision !== "attempt") return;

    // Spend the guard BEFORE leaving, and never hand it back: this survives the
    // trip to Google, which is the entire point. No cleanup function on purpose
    // — a cleanup here is what restarted the loop every single time.
    setGuard();

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
