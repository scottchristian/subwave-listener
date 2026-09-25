"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import LikedSongsPanel from "@/app/components/LikedSongsPanel";

export default function LikesPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    if (status === "authenticated" && !(session?.user as any)?.isApproved) router.push("/");
    if (status === "authenticated" && (session?.user as any)?.isApproved) setReady(true);
  }, [status, session, router]);

  if (!ready) {
    return <div className="container centered-column" style={{ justifyContent: "center" }}>Loading…</div>;
  }

  return (
    <main id="main-likes" className="container" style={{ paddingTop: "2rem" }}>
      <header id="header-likes" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <h1 className="logo-text" style={{ fontSize: "1.5rem" }}>Liked Songs</h1>
        <a id="btn-back-to-station-likes" href="/" className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", width: "auto" }}>Back to Station</a>
      </header>
      <LikedSongsPanel />
    </main>
  );
}
