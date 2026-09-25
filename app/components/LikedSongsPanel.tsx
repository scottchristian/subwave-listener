"use client";

import { useEffect, useState } from "react";

import { STATION } from "@/lib/station";
const STATION_API = STATION.backendUrl;

const SpotifyGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
  </svg>
);

const AppleGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z" />
  </svg>
);

const RequestGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

function LikedRow({ like, myUserId, onUnlike, onRequest, requested }: {
  like: any;
  myUserId: string | null;
  onUnlike: (trackId: string) => void;
  onRequest: (like: any) => void;
  requested: boolean;
}) {
  const [links, setLinks] = useState<{ spotify: string | null, apple: string | null }>({ spotify: null, apple: null });
  const [open, setOpen] = useState(false);
  const [likedBy, setLikedBy] = useState<string | null>(null);
  const title = like.title || "Unknown title";
  const subtitle = like.title
    ? [like.artist, like.album].filter(Boolean).join(" · ") || "Unknown artist"
    : "Liked before titles were saved";
  const likedAt = like.createdAt
    ? new Date(like.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;

  useEffect(() => {
    if (!open || !like.title) return;
    const query = new URLSearchParams({
      trackId: like.trackId,
      title: like.title,
      artist: like.artist || "",
      album: like.album || "",
    });
    fetch(`/api/links?${query.toString()}`)
      .then(r => r.json())
      .then(d => setLinks({ spotify: d.spotifyUrl || null, apple: d.appleMusicUrl || null }))
      .catch(() => {});
  }, [open, like.trackId, like.title, like.artist, like.album]);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/likes?trackId=${encodeURIComponent(like.trackId)}`)
      .then(r => r.json())
      .then(d => {
        const others = ((d.likes) || []).filter((l: any) => l.userId !== myUserId);
        if (!others.length) {
          setLikedBy(null);
          return;
        }
        const named = others.map((l: any) => l.user?.name).filter(Boolean) as string[];
        const anon = others.length - named.length;
        const parts = [...named];
        if (anon > 0) parts.push(`Anonymous ×${anon}`);
        setLikedBy(parts.join(", "));
      })
      .catch(() => {});
  }, [open, like.trackId, myUserId]);

  const spotifyHref = links.spotify || (like.title ? `https://open.spotify.com/search/${encodeURIComponent(`track:"${like.title}" artist:"${like.artist || ""}"`)}` : null);
  const appleHref = links.apple || (like.title ? `https://music.apple.com/search?term=${encodeURIComponent(`${like.title} ${like.artist || ""}`)}` : null);
  const actionBtn = {
    display: "flex", alignItems: "center", gap: "0.5rem",
    padding: "0.55rem 0.9rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600,
    background: "rgba(255,255,255,0.07)", color: "var(--color-text)", border: "1px solid rgba(255,255,255,0.14)",
    cursor: "pointer", textDecoration: "none",
  } as const;

  return (
    <div id={`liked-row-${like.id}`} style={{ borderBottom: "1px solid var(--color-border)" }}>
      <button
        id={`liked-expand-${like.id}`}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ display: "grid", gridTemplateColumns: "44px 1fr auto", gap: "0.75rem", alignItems: "center", width: "100%", padding: "0.6rem 0.25rem", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "inherit" }}
      >
        <img
          id={`liked-art-${like.id}`}
          src={`${STATION_API}/api/cover/${like.trackId}`}
          alt=""
          onError={(e) => { (e.target as HTMLImageElement).src = "/official_logo.png"; }}
          style={{ width: "44px", height: "44px", objectFit: "cover", borderRadius: "6px" }}
        />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "0.95rem", fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {title}
          </span>
          <span style={{ display: "block", fontSize: "0.8rem", color: "var(--color-text)", opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "0.15rem" }}>
            {subtitle}
          </span>
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--color-muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s ease", flexShrink: 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div id={`liked-detail-${like.id}`} style={{ display: "grid", gridTemplateRows: open ? "1fr" : "0fr", transition: "grid-template-rows 0.25s ease", overflow: "hidden" }}>
        <div style={{ overflow: "hidden", minHeight: 0 }}>
        <div style={{ padding: "0 0.25rem 0.8rem 56px" }}>
          {likedAt && (
            <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginBottom: "0.6rem" }}>
              Liked {likedAt}{likedBy ? ` · ${likedBy}` : ""}
            </div>
          )}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {spotifyHref && <a id={`liked-spotify-${like.id}`} href={spotifyHref} target="_blank" rel="noreferrer" style={actionBtn}> <SpotifyGlyph /> Spotify </a>}
            {appleHref && <a id={`liked-apple-${like.id}`} href={appleHref} target="_blank" rel="noreferrer" style={actionBtn}> <AppleGlyph /> Apple Music </a>}
            {like.title && (
              <button
                id={`liked-request-${like.id}`}
                onClick={() => onRequest(like)}
                style={{ ...actionBtn, color: requested ? "var(--color-accent)" : "var(--color-text)", borderColor: requested ? "var(--color-accent)" : "rgba(255,255,255,0.14)" }}
              >
                <RequestGlyph /> {requested ? "Requested" : "Request again"}
              </button>
            )}
            <button
              id={`liked-unlike-${like.id}`}
              onClick={() => onUnlike(like.trackId)}
              style={{ ...actionBtn, color: "#f2f2f2", borderColor: "rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.10)" }}
            >
              Unlike
            </button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

export default function LikedSongsPanel() {
  const [likes, setLikes] = useState<any[]>([]);
  const [hideName, setHideName] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [requestedIds, setRequestedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/likes/mine")
      .then(r => r.json())
      .then(d => {
        if (d.likes) setLikes(d.likes);
        setHideName(!!d.hideLikeName);
        setMyUserId(d.userId || null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const toggleHide = async () => {
    const next = !hideName;
    setHideName(next);
    try {
      await fetch("/api/likes/preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideLikeName: next }),
      });
    } catch {
      setHideName(!next);
    }
  };

  const unlike = async (trackId: string) => {
    setLikes(ls => ls.filter(l => l.trackId !== trackId));
    try {
      await fetch("/api/likes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, action: "unlike" }),
      });
    } catch {}
  };

  const requestAgain = async (like: any) => {
    if (requestedIds[like.trackId]) return;
    setRequestedIds(m => ({ ...m, [like.trackId]: true }));
    try {
      await fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track: `${like.title} - ${like.artist || ""}`.trim() }),
      });
    } catch {}
  };

  if (!loaded) {
    return <p className="about-text">Loading…</p>;
  }

  return (
    <>
      <div className="card" style={{ marginBottom: "1rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <span id="hide-like-label">Hide my name on likes</span>
        <button
          id="toggle-hide-like-name"
          role="switch"
          aria-checked={hideName}
          aria-labelledby="hide-like-label"
          onClick={toggleHide}
          style={{
            flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
            backgroundColor: hideName ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
            position: "relative", transition: "background-color 0.2s ease", padding: 0,
          }}
        >
          <span style={{
            position: "absolute", top: "2px", left: hideName ? "23px" : "2px", width: "23px", height: "23px",
            borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
          }} />
        </button>
      </div>

      <div id="liked-list">
        {likes.length === 0 && <p className="about-text">No likes yet — tap the heart on anything playing.</p>}
        {likes.map(l => (
          <LikedRow key={l.id} like={l} myUserId={myUserId} onUnlike={unlike} onRequest={requestAgain} requested={!!requestedIds[l.trackId]} />
        ))}
      </div>
    </>
  );
}
