"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import AuthFailure from "@/app/components/AuthFailure";

/**
 * The station's sign-in page. NextAuth forces failed sign-ins here (its own
 * allowlist bypasses pages.error for Callback-class errors), so this is both
 * the front door and the failure page — the error code decides which words.
 *
 * If the user has the "remember me" cookie (set on successful login), we
 * automatically trigger the Google sign-in flow. This is useful when the
 * database was hibernated — the user doesn't need to click the button, the
 * wake logic in the auth adapter will wake the database and complete the flow.
 */
function SigninBody() {
  const params = useSearchParams();
  const errorCode = params.get("error") || "";
  const isWakingDb = errorCode && [
    "Callback",
    "OAuthCallback",
    "OAuthCreateAccount",
    "OAuthSignin",
    "Signin",
    "AdapterError",
    "default",
  ].includes(errorCode);

  // Auto-trigger sign-in if user has the "remember me" cookie and we're on the
  // sign-in page (either first visit or database-waking error).
  // We only do this once per page load to avoid redirect loops.
  useEffect(() => {
    const hasRememberCookie = document.cookie.includes("subwave_remember=true");
    const isErrorPage = !!errorCode;
    const isFirstVisit = !isErrorPage;

    // Auto-sign in if:
    // 1. User has the remember cookie
    // 2. Either it's their first visit (no error code) OR they hit a DB-waking error
    // 3. We haven't already attempted (tracked via sessionStorage)
    const shouldAutoSignIn = hasRememberCookie && (isFirstVisit || isWakingDb);

    if (shouldAutoSignIn && !sessionStorage.getItem("subwave_auto_signin_attempted")) {
      sessionStorage.setItem("subwave_auto_signin_attempted", "true");
      signIn("google", { callbackUrl: "/" });
    }
  }, [errorCode]);

  // Clear the attempt flag on successful auth (handled by next-auth redirect)
  // or on page unload
  useEffect(() => {
    return () => {
      sessionStorage.removeItem("subwave_auto_signin_attempted");
    };
  }, []);

  return <AuthFailure code={errorCode} />;
}

export default function SigninPage() {
  return (
    <Suspense>
      <SigninBody />
    </Suspense>
  );
}
