"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AuthFailure from "@/app/components/AuthFailure";

/**
 * The station's sign-in page. NextAuth forces failed sign-ins here (its own
 * allowlist bypasses pages.error for Callback-class errors), so this is both
 * the front door and the failure page — the error code decides which words.
 */
function SigninBody() {
  const params = useSearchParams();
  return <AuthFailure code={params.get("error") || ""} />;
}

export default function SigninPage() {
  return (
    <Suspense>
      <SigninBody />
    </Suspense>
  );
}
