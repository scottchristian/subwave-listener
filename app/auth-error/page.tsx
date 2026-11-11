"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import AuthFailure from "@/app/components/AuthFailure";

/**
 * Where the error classes NextAuth does not force onto /signin land (see
 * pages.error in the NextAuth options). Same words as the signin page — one
 * component, two doors.
 */
function AuthErrorBody() {
  const params = useSearchParams();
  return <AuthFailure code={params.get("error") || ""} />;
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <AuthErrorBody />
    </Suspense>
  );
}
