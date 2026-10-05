"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

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
            The station database was probably asleep or paused when you tried — it wakes on its own, but waking takes
            a minute. Wait a little, then try again. If it keeps failing, the database needs resuming in its dashboard.
          </p>
        )}
        <button
          id="btn-retry-signin"
          className="primary-btn"
          onClick={() => signIn("google", { callbackUrl: "/" })}
        >
          {denied ? "Sign in with Google" : "Try again"}
        </button>
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
