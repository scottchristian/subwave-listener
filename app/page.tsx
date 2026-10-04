"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import LoadingDots from "@/app/components/LoadingDots";
import LikeButton from "@/app/components/LikeButton";
import LikedSongsPanel from "@/app/components/LikedSongsPanel";
import SkillsPanel from "@/app/components/SkillsPanel";
import { STATION } from "@/lib/station";
import { plog, setVerbose } from "@/lib/log";
import { canSkipAsListener, parseSkipVisibility, type SkipVisibility } from "@/lib/skipvisibility";
import { APP_VERSION, REPO_URL, SUBWAVE_URL } from "@/lib/version";
import { resolveTrackDuration, isDurationDiscredited } from "@/lib/trackduration";
// The request ladder: what we tell a listener while the booth has not answered.
import {
  requestWaitMessage,
  REQUEST_TIMEOUT_SEC,
  REQUEST_TIMEOUT_MESSAGE,
} from "@/lib/requestwait";

// The software, not the station. Deliberately not env-driven: an operator
// renaming their station should not rename the project, and the version footer is
// where the two would otherwise get confused.
const APP_NAME = "Subwave Listener";

// Minimal icons
const PlayIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const StopIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 6h12v12H6z" />
  </svg>
);
const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
const SpotifyIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.54.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.6.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.54-1.02.72-1.56.3z" />
  </svg>
);
const AppleMusicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z" />
  </svg>
);

const WeatherIcon = ({ condition }: { condition?: string }) => {
  if (!condition) return null;
  const c = condition.toLowerCase();
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
        <path d="M16 14v6" /><path d="M8 14v6" /><path d="M12 16v6" />
      </svg>
    );
  }
  if (c.includes('cloud') || c.includes('overcast')) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      </svg>
    );
  }
  // Default (sunny / clear / everything else)
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" /><path d="M5 5l1.5 1.5" /><path d="M17.5 17.5L19 19" />
      <path d="M2 12h2" /><path d="M20 12h2" /><path d="M5 19l1.5-1.5" /><path d="M17.5 6.5L19 5" />
    </svg>
  );
};

const SongCountdown = ({ nowPlaying, bufferSeconds, duration }: { nowPlaying: any, bufferSeconds: number, duration: number | null }) => {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!nowPlaying || !nowPlaying.timestamp) {
      setElapsed(null);
      setRemaining(null);
      return;
    }

    // Duration may come from now-playing or from the history fallback the caller
    // resolved — either way it is a real length, not a guess. Without any length
    // there is still something honest to show: how long it has been on, which is
    // always knowable from the timestamp.
    const audibleStart = Number(nowPlaying.timestamp) + (bufferSeconds || 0);
    const audibleEnd = duration != null ? audibleStart + duration : null;
    
    // Run once immediately, then every second
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      if (audibleEnd != null) {
        const raw = audibleEnd - now;
        if (isDurationDiscredited(raw)) {
          // Outlived its supposed length: the resolved duration was an
          // underestimate (a history airing cut short by a skip), and -0:00
          // stuck on screen is exactly what that looks like. Show how long it
          // has actually been on instead.
          setRemaining(null);
          setElapsed(Math.max(0, now - audibleStart));
        } else {
          // Clamp at 0 rather than hiding: the display holds the old track until
          // the delayed promotion commits, and a vanishing timer reads as broken.
          setRemaining(raw >= 0 ? raw : 0);
          setElapsed(null);
        }
      } else {
        setRemaining(null);
        setElapsed(Math.max(0, now - audibleStart));
      }
    };
    
    update();
    const interval = setInterval(update, 1000);

    return () => clearInterval(interval);
  }, [nowPlaying, bufferSeconds, duration]);

  if (remaining === null && elapsed === null) return null;

  const show = (remaining !== null ? remaining : elapsed) as number;
  const mins = Math.floor(show / 60);
  const secs = Math.floor(show % 60);
  
  return (
    <div id="song-countdown" style={{ color: "var(--color-muted)", fontSize: "0.95rem", fontWeight: 500, marginTop: "0.25rem" }}>
      {remaining !== null
        ? <>-{mins}:{secs.toString().padStart(2, "0")} remaining</>
        : <>{mins}:{secs.toString().padStart(2, "0")} on air</>}
    </div>
  );
};

export default function Home() {
  const { data: session, status } = useSession();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [stationData, setStationData] = useState<any>(null);
  const [appStateData, setAppStateData] = useState<any>(null);
  const [scheduleData, setScheduleData] = useState<any>(null);
  const [reqSong, setReqSong] = useState("");
  const [reqName, setReqName] = useState("");
  const [reqAck, setReqAck] = useState("");
  // A request is not one action, it is three: posting it, waiting for the booth to
  // answer, and settling. Only the last of those knows how it turned out, so the
  // earlier two have to say something honest rather than a single fixed line that
  // turns out to be true for as long as the tab is open.
  const [reqStage, setReqStage] = useState<"idle" | "posting" | "waiting">("idle");
  const [reqWaitSecs, setReqWaitSecs] = useState(0);
  const [pendingReqId, setPendingReqId] = useState<string | null>(null);

  const [isAsleepWakeup, setIsAsleepWakeup] = useState(false);
  // Post-awake stall indicator: rebuffering after the stream started shows
  // the same loading treatment (debounced so micro-stalls don't flash it).
  const [isBuffering, setIsBuffering] = useState(false);
  const bufferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Admin on-air controls (mirrors Subwave admin Never-play + Skip).
  const [adminAck, setAdminAck] = useState("");
  const [adminBusy, setAdminBusy] = useState<"skip" | "block" | null>(null);
  const [adminAckShow, setAdminAckShow] = useState(false);
  const adminAckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Centered flash: fades in, holds 3s, fades out, then clears.
  const flashAdminAck = (msg: string) => {
    if (adminAckTimer.current) clearTimeout(adminAckTimer.current);
    setAdminAck(msg);
    setAdminAckShow(true);
    adminAckTimer.current = setTimeout(() => {
      setAdminAckShow(false);
      adminAckTimer.current = setTimeout(() => setAdminAck(""), 300);
    }, 3000);
  };
  useEffect(() => () => {
    if (adminAckTimer.current) clearTimeout(adminAckTimer.current);
    if (sayAckTimer.current) clearTimeout(sayAckTimer.current);
  }, []);
  // Admin manual voice DJ (mirrors Subwave POST /dj/say).
  const [sayText, setSayText] = useState("");
  const [sayMode, setSayMode] = useState<"raw" | "styled">("raw");
  const [sayKind, setSayKind] = useState<"dj-speak" | "link">("dj-speak");
  const [sayBusy, setSayBusy] = useState(false);
  const [sayAck, setSayAck] = useState("");
  const [sayAckShow, setSayAckShow] = useState(false);
  const sayAckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSayAck = (msg: string) => {
    if (sayAckTimer.current) clearTimeout(sayAckTimer.current);
    setSayAck(msg);
    setSayAckShow(true);
    sayAckTimer.current = setTimeout(() => {
      setSayAckShow(false);
      sayAckTimer.current = setTimeout(() => setSayAck(""), 300);
    }, 3000);
  };
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  // Post-skip cooldown: the delayed art commit won't show the skip for
  // bufferSeconds, so hold the button (buffer + 15s) to stop double-skips.
  const [skipCooldownLeft, setSkipCooldownLeft] = useState(0);
  const skipCooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Request anti-spam: 30s button cooldown after every accepted send (the
  // server enforces the same window, so curl can't dodge it).
  const [reqCooldownLeft, setReqCooldownLeft] = useState(0);
  const reqCooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startReqCooldown = (secs: number) => {
    if (reqCooldownTimer.current) clearInterval(reqCooldownTimer.current);
    setReqCooldownLeft(Math.max(Math.ceil(secs), 1));
    reqCooldownTimer.current = setInterval(() => {
      setReqCooldownLeft(left => {
        if (left <= 1) {
          if (reqCooldownTimer.current) clearInterval(reqCooldownTimer.current);
          reqCooldownTimer.current = null;
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };
  // Silence watchdog: the element fires error/stalled long after data stops.
  // Track last bytes via progress; 8s of silence with intent to play triggers
  // an early reload while the old buffer may still be covering the gap.
  const [reconnecting, setReconnecting] = useState(false);
  const lastDataRef = useRef(0);
  const lastTimeRef = useRef(0);
  const recoveringRef = useRef(false);
  const backendDownRef = useRef(false);
  // Shadow pre-connect: background element buffering the same stream so a
  // dying primary swaps over hot instead of reloading cold.
  const shadowRef = useRef<HTMLAudioElement | null>(null);
  const shadowBornRef = useRef(0);
  const lastShadowDropRef = useRef(0);
  const earlyRecoverRef = useRef<((reason: string) => void) | null>(null);
  const handleAwakeRef = useRef<(() => void) | null>(null);
  // Likes open as an overlay so the <audio> element stays mounted and the
  // stream keeps playing. (Navigating to /likes unmounts the player.)
  const [showLikes, setShowLikes] = useState(false);
  // Header account menu + self nickname.
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Skills open as an overlay for the same reason likes do — a route change
  // unmounts the <audio> element and the stream stops.
  const [showSkills, setShowSkills] = useState(false);
  // Host/guest profile popup. Same overlay treatment as likes, for the same
  // reason: the stream must keep playing. One popup, whoever is tapped — the
  // data only ever carries one host plus guests, so "multiple hosts" means
  // every face on air opens its own card.
  const [showHost, setShowHost] = useState<{ name: string; avatar: string; role: string; tagline?: string } | null>(null);
  // Fixed viewport position for the menu, clamped on-screen at open time.
  const [userMenuPos, setUserMenuPos] = useState<{ top: number; left: number } | null>(null);
  const userMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const userMenuElRef = useRef<HTMLDivElement | null>(null);
  /**
   * Place the menu under the Account button, measured live rather than once at
   * open time.
   *
   * The button is at the top of the page and the menu is position: fixed, so the
   * two only agree until the page scrolls — after which the button moves and the
   * menu stays where it was, leaving it floating over unrelated content with
   * nothing to click back to. Re-measuring on scroll and resize keeps it attached.
   *
   * `preferAbove` flips the menu above the button when there is not enough room
   * below. Without it a button near the bottom of a short viewport pushes the menu
   * off the bottom of the screen, taking the sign-out button with it.
   */
  const positionUserMenu = () => {
    const r = userMenuBtnRef.current?.getBoundingClientRect();
    if (!r) { setUserMenuPos(null); return; }
    const w = userMenuElRef.current?.offsetWidth || 260;
    const h = userMenuElRef.current?.offsetHeight || 0;
    const gap = 8, edge = 8;

    // Below the button if it fits with a little room to spare, otherwise above it.
    const roomBelow = window.innerHeight - r.bottom - gap;
    const preferAbove = h > 0 && h > roomBelow && r.top - gap - h >= edge;
    const top = preferAbove ? r.top - gap - h : r.bottom + gap;

    setUserMenuPos({
      // Clamped last so a menu taller than the viewport still starts on screen
      // rather than hanging off the top with its first entries unreachable.
      top: Math.min(Math.max(top, edge), Math.max(window.innerHeight - h - edge, edge)),
      left: Math.min(Math.max(r.left, edge), Math.max(window.innerWidth - w - edge, edge)),
    });
  };

  const openUserMenu = () => {
    setUserMenuOpen(true);
    // Measured after the open flag commits, so the menu exists in the DOM and its
    // real height is available. Measuring before this renders gives offsetHeight 0,
    // so the flip-above logic silently does nothing on the first open and the menu
    // is positioned by the 260px-width fallback alone.
    requestAnimationFrame(positionUserMenu);
  };

  // Keep it attached while it is open. `true` for capture: the page also scrolls
  // inside .overlay-scroll areas that are not the window, and those do not bubble
  // a scroll event to it. Removed on close so a closed menu costs no listener.
  useEffect(() => {
    if (!userMenuOpen) return;
    const update = () => positionUserMenu();
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
    // positionUserMenu is stable in practice and depends only on refs; re-running on
    // every render would re-bind the listeners constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMenuOpen]);
  const [nickDraft, setNickDraft] = useState("");
  const [myNickname, setMyNickname] = useState<string | null>(null);
  const [nickLoaded, setNickLoaded] = useState(false);

  useEffect(() => {
    if (!userMenuOpen) return;
    fetch("/api/me")
      .then(r => r.json())
      .then(d => {
        if (typeof d.nickname === "string" && d.nickname) {
          setMyNickname(d.nickname);
          setNickDraft(d.nickname);
        } else {
          setNickDraft("");
        }
        if (typeof d.hideLikeName === "boolean") setMenuHideName(d.hideLikeName);
      })
      .catch(() => {});
  }, [userMenuOpen]);

  const [menuHideName, setMenuHideName] = useState(false);

  const toggleMenuHideName = async () => {
    const next = !menuHideName;
    setMenuHideName(next);
    try {
      await fetch("/api/likes/preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hideLikeName: next }),
      });
    } catch {
      setMenuHideName(!next);
    }
  };

  useEffect(() => {
    if (!userMenuOpen || nickLoaded) return;
    fetch("/api/me")
      .then(r => r.json())
      .then(d => {
        if (typeof d.nickname === "string" && d.nickname) {
          setMyNickname(d.nickname);
          setNickDraft(d.nickname);
        }
        setNickLoaded(true);
      })
      .catch(() => setNickLoaded(true));
  }, [userMenuOpen, nickLoaded]);

  const saveMyNickname = async () => {
    try {
      const res = await fetch("/api/profile/nickname", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickDraft }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMyNickname(data.nickname || null);
    } catch {}
  };


  // Pending-approval poll: approved flips you in, a deleted account flips to
  // an explicit denied screen instead of pending forever.
  const [accessDenied, setAccessDenied] = useState(false);
  // Art overlay: hover-driven on desktop, always-on-when-paused on touch.
  const [artHover, setArtHover] = useState(false);
  const canHoverArt = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(hover: hover)").matches;
  
  const [donateUrl, setDonateUrl] = useState(STATION.donateUrl);
  const [donateText, setDonateText] = useState("Send a tip to keep the station alive ☕");
  const [donateEnabled, setDonateEnabled] = useState(true);
  
  const [directLinks, setDirectLinks] = useState<{ spotify: string | null, apple: string | null }>({ spotify: null, apple: null });
  const [trackExplicit, setTrackExplicit] = useState(false);
  // Lock-screen explicit tag (🅴 suffix). Admin toggle, defaults on.
  const [explicitSuffix, setExplicitSuffix] = useState(true);
    // Who gets the Skip button — operator setting, see lib/skipvisibility.ts.
    // Defaults to solo, which is what the station has always done.
    const [skipVisibility, setSkipVisibility] = useState<SkipVisibility>("solo");
  // The three header chips. Operator toggles in Admin -> Station -> Header.
  // Default on: a station that has never touched them looks exactly as it
  // did before the toggles existed.
  const [headerListeners, setHeaderListeners] = useState(true);
  const [headerWeather, setHeaderWeather] = useState(true);
  const [headerVibe, setHeaderVibe] = useState(true);
  const [signedInCount, setSignedInCount] = useState<number | null>(null);
  // Maintenance: admins see the player regardless; everyone else gets the notice.
  // Maintenance: admins see the player regardless; everyone else gets the notice.
  const [maintMode, setMaintMode] = useState(false);
  const [maintMsg, setMaintMsg] = useState("");
  // Backend reachability: consecutive now-playing failures grey the player
  // out with a notice. Three strikes (15s) so one blip never flashes it.
  const [backendDown, setBackendDown] = useState(false);
  const backendFailRef = useRef(0);
  useEffect(() => { backendDownRef.current = backendDown; }, [backendDown]);
  // Stream path: relay proxy (default) or direct 1:1 to the master.
  // Refreshed with settings; mode flips take effect on next Play.
  const streamCfgRef = useRef<{ mode: string; directUrl: string }>({ mode: "relay", directUrl: "" });
  const streamSrc = () => {
    const cfg = streamCfgRef.current;
    if (cfg.mode === "direct" && cfg.directUrl) return `${cfg.directUrl}${cfg.directUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    return `/api/stream?t=${Date.now()}`;
  };

  // Typing animation for request placeholder
  const placeholders = [
    "e.g. Fleetwood Mac - Dreams",
    "e.g. play me some 80's hits",
    "e.g. Shout out to Johno, it's his birthday!",
    "e.g. Surprise me with something upbeat",
    "e.g. Happy anniversary to Sarah!"
  ];
  const [phText, setPhText] = useState("");
  const [phIndex, setPhIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentString = placeholders[phIndex];
    let typingSpeed = isDeleting ? 30 : 60;
    
    if (!isDeleting && phText === currentString) {
      const timeout = setTimeout(() => setIsDeleting(true), 2500);
      return () => clearTimeout(timeout);
    } else if (isDeleting && phText === "") {
      setIsDeleting(false);
      setPhIndex((prev) => (prev + 1) % placeholders.length);
      return;
    }

    const timeout = setTimeout(() => {
      setPhText(currentString.substring(0, phText.length + (isDeleting ? -1 : 1)));
    }, typingSpeed);

    return () => clearTimeout(timeout);
  }, [phText, isDeleting, phIndex]);

  // Typing animation for name placeholder
  const namePlaceholders = [
    "e.g. Captain Chaos",
    "e.g. DJ Funky Fresh",
    "e.g. The Midnight Rider",
    "e.g. Anonymous Bob",
    "e.g. Your real name (or not, whatever!)",
    "e.g. A sentient toaster"
  ];
  const [phNameText, setPhNameText] = useState("");
  const [phNameIndex, setPhNameIndex] = useState(0);
  const [isNameDeleting, setIsNameDeleting] = useState(false);

  useEffect(() => {
    const currentString = namePlaceholders[phNameIndex];
    let typingSpeed = isNameDeleting ? 30 : 60;
    
    if (!isNameDeleting && phNameText === currentString) {
      const timeout = setTimeout(() => setIsNameDeleting(true), 2500);
      return () => clearTimeout(timeout);
    } else if (isNameDeleting && phNameText === "") {
      setIsNameDeleting(false);
      setPhNameIndex((prev) => (prev + 1) % namePlaceholders.length);
      return;
    }

    const timeout = setTimeout(() => {
      setPhNameText(currentString.substring(0, phNameText.length + (isNameDeleting ? -1 : 1)));
    }, typingSpeed);

    return () => clearTimeout(timeout);
  }, [phNameText, isNameDeleting, phNameIndex]);

  useEffect(() => {
    // Every /api route now requires a session (see proxy.ts), and an anonymous
    // visitor has none — so this waits for one rather than firing a 401 on
    // every anonymous page load. The dep must be [status]: on the first render
    // the status is "loading", so with an empty dep list this effect runs once,
    // bails out, and never fetches settings for anyone.
    if (status !== "authenticated") return;
    fetch("/api/settings").then(r => r.json()).then(d => {
       if (d.donate_url) setDonateUrl(d.donate_url);
       if (d.donate_text) setDonateText(d.donate_text);
       if (typeof d.donate_enabled === "boolean") setDonateEnabled(d.donate_enabled);
       if (typeof d.maintenanceMode === "boolean") setMaintMode(d.maintenanceMode);
       if (typeof d.maintenanceMessage === "string") setMaintMsg(d.maintenanceMessage);
       if (typeof d.verboseLogging === "boolean") setVerbose(d.verboseLogging);
       if (typeof d.explicitSuffix === "boolean") setExplicitSuffix(d.explicitSuffix);
         if (d.skipVisibility) setSkipVisibility(parseSkipVisibility(d.skipVisibility));
         if (typeof d.headerListeners === "boolean") setHeaderListeners(d.headerListeners);
         if (typeof d.headerWeather === "boolean") setHeaderWeather(d.headerWeather);
         if (typeof d.headerVibe === "boolean") setHeaderVibe(d.headerVibe);
       plog.info("settings loaded", { streamMode: d.streamMode, donate: d.donate_enabled, maint: d.maintenanceMode, verbose: d.verboseLogging });
       const mode = d.streamMode === "direct" ? "direct" : "relay";
       let directUrl = "";
       if (mode === "direct" && STATION.backendUrl) {
         const base = STATION.backendUrl.replace(/\/+$/, "").replace(/\/api$/, "");
         directUrl = d.stationPassword
           ? `${base}/stream.mp3?auth=${encodeURIComponent(d.stationPassword)}`
           : `${base}/stream.mp3`;
       }
       streamCfgRef.current = { mode, directUrl };
    }).catch((e) => plog.error("settings unreachable", e instanceof Error ? e.message : e));
    }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const load = () => {
      fetch("/api/presence")
        .then(r => r.json())
        .then(d => { if (typeof d.signedIn === "number") setSignedInCount(d.signedIn); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [status]);
  
  const [tourStep, setTourStep] = useState(-1);
  const [tooltipStyle, setTooltipStyle] = useState<{ top?: string; bottom?: string; left?: string; right?: string; width?: string; transform?: string; opacity: number }>({ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', opacity: 0 });
  // Spotlight frame geometry around the tour target. One fixed frame glides
  // between elements (geometry transitions) instead of restyling each one.
  const [tourSpot, setTourSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const intendedPlayRef = useRef(false);
  const hasAwakeRef = useRef(false);
  // Stable boolean: the <audio> node only exists in the approved-player
  // branch, which mounts after session resolves. The bind effect below must
  // re-run on this (not on []) or it binds while audio is null and the
  // player runs forever with no events — stuck "Waking up".
  const isApprovedPlayer =
    status === "authenticated" && !!(session?.user as any)?.isApproved;
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const STATION_API = STATION.backendUrl;

  // The station's name belongs to the SUB/WAVE host, and /state already carries it
  // in every poll the player was making anyway — it was being fetched and ignored.
  // Preferring it here is what makes the host the real source: rename the station
  // there and this follows on the next poll, with no rebuild and no second copy.
  //
  // STATION.name stays as the value for first paint, the browser tab before the
  // first poll lands, and the build-time metadata that cannot wait for a fetch.
  const hostStationName: string | null = appStateData?.station?.name || null;
  const stationName = hostStationName || STATION.name;

  // The track length, for the countdown, the skip lock and the lock screen.
  // now-playing.duration is null whenever the host does not know it (untracked
  // pick, untagged file), so without the history fallback all three silently
  // stop — which reads as a broken player rather than an unknown length.
  const trackDuration: number | null = resolveTrackDuration(
    stationData?.nowPlaying,
    appStateData?.history
  );

  // Keep the tab title in step, for the same reason. The static title in the layout
  // is whatever was true at build time and cannot know any of this.
  useEffect(() => {
    if (!hostStationName) return;
    document.title = hostStationName;
  }, [hostStationName]);

  const lastTrackKeyRef = useRef<string | null>(null);
  const promoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Freshest fetch, so a held promotion commits latest data (a request queued
  // mid-hold still lands on time). Subsonic id of the committed now-playing,
  // to spot the backend queue moving ahead of what is on display.
  const latestFetchRef = useRef<{ key: string | null; newData: any; newSchedule: any; newState: any } | null>(null);
  const lastSubsonicRef = useRef<string | null>(null);
  // Signature of the last committed lineup (track + upcoming ids). Instant
  // polls that change nothing apply silently instead of snapshotting.
  const lastCommitSigRef = useRef<string | null>(null);
  const lastLineupRef = useRef<string | null>(null);

  useEffect(() => {
    if (status === "authenticated" && (session?.user as any)?.isApproved) {
      if (localStorage.getItem("hasSeenTour") !== "true") {
        setTourStep(0);
      }
    }

    let isCancelled = false;

      const fetchStation = async () => {
        let backendOk = false;
        try {
          // Fallbacks intentionally NOT using the state variables, because closures capture the old state.
          // In React you would ideally use a ref to track the latest state, but we'll accept whatever was captured here if fetch fails, 
          // or we just skip applying the failed request. Let's just handle it cleanly!
          const npRes = await fetch(`${STATION_API}/api/now-playing`);
          backendOk = npRes.ok;
          if (!npRes.ok) plog.warn("now-playing failed", { status: npRes.status });
          const newData = npRes.ok ? await npRes.json() : null;

          const schRes = await fetch(`${STATION_API}/api/schedule`);
          if (!schRes.ok) plog.warn("schedule failed", { status: schRes.status });
          const newSchedule = schRes.ok ? await schRes.json() : null;

          const stRes = await fetch(`${STATION_API}/api/state`);
          if (!stRes.ok) plog.warn("state failed", { status: stRes.status });
          const newState = stRes.ok ? await stRes.json() : null;

          if (isCancelled) return;
          
          const applyTriple = (t: { newData: any; newSchedule: any; newState: any }, animate = true) => {
            if (isCancelled) return;
            const doApply = () => {
              if (t.newData) setStationData(t.newData);
              if (t.newSchedule) setScheduleData(t.newSchedule);
              if (t.newState) setAppStateData(t.newState);
            };

            // Snapshotting identical DOM flashes white for nothing — only
            // animate when something visible actually changed. Hidden tabs
            // can't transition (InvalidStateError) — apply directly.
            if (animate && !document.hidden && typeof window !== "undefined" && typeof (document as any).startViewTransition === "function") {
              import("react-dom").then((ReactDOM) => {
                try {
                  const t = (document as any).startViewTransition(() => {
                    ReactDOM.flushSync(doApply);
                  });
                  if (t && typeof t.catch === "function") t.catch(() => doApply());
                } catch {
                  doApply();
                }
              });
            } else {
              doApply();
            }
          };

          // Content signature for change-gating: fresh objects every poll
          // re-rendered the page and refired every nowPlaying effect even
          // when nothing changed. Plain concat on purpose — keep it boring.
          const feedSig = (d: any, sch: any, st: any) => {
            const np = d ? d.nowPlaying : null;
            const up = d && d.upcoming ? d.upcoming.map(function (x: any) { return x.subsonic_id || x.title; }).join(",") : "";
            const schS = sch ? JSON.stringify(sch) : "null";
            const curS = st && st.current ? JSON.stringify(st.current) : "null";
            return [np ? np.subsonic_id : "", np ? np.title : "", np ? np.artist : "", np ? np.album : "", up,
              d && d.listeners ? d.listeners.current : "", d && d.activeShow ? d.activeShow.name : "",
              d && d.dj ? d.dj.name : "", d && d.stream ? d.stream.bufferSeconds : "", schS, curS].join("|");
          };
          const lineupSig = (d: any) => {
            const np = d ? d.nowPlaying : null;
            const up = d && d.upcoming ? d.upcoming.map(function (x: any) { return x.subsonic_id || x.title; }).join(",") : "";
            return (np ? np.subsonic_id : "") + "::" + up;
          };

          const np = newData?.nowPlaying;
          const trackKey = np ? `${np.title}\u0000${np.artist}` : null;
          const bufSec = newData?.stream?.bufferSeconds;

          // Stash every fetch; held promotions commit the freshest data.
          latestFetchRef.current = { key: trackKey, newData, newSchedule, newState };
          
          let wait = 0;
          if (typeof bufSec === 'number' && Number.isFinite(bufSec)) {
            const leadMs = Math.min(Math.max(bufSec, 0), 60) * 1000;
            const cur = newState?.current;
            let serverStart = NaN;
            if (np?.title && cur && cur.title === np.title && cur.startedAt) {
              const t = Date.parse(cur.startedAt);
              if (Number.isFinite(t) && t <= Date.now()) serverStart = t;
            }
            const audibleAt = Number.isFinite(serverStart) ? serverStart + leadMs : Date.now();
            wait = audibleAt - Date.now();
          }

          // True when the backend queue already moved past the committed
          // display (handed-over `sent` items): state's current id no longer
          // matches the on-screen now-playing. Id-compared, never title-compared.
          const stCur = newState?.current;
          const backendAhead =
            lastSubsonicRef.current != null &&
            stCur?.subsonic_id != null &&
            stCur.subsonic_id !== lastSubsonicRef.current;

          if (trackKey !== lastTrackKeyRef.current) {
            const commit = () => {
              promoteTimerRef.current = null;
              const latest = latestFetchRef.current;
              lastTrackKeyRef.current = latest?.key ?? trackKey;
              lastSubsonicRef.current = latest?.newData?.nowPlaying?.subsonic_id ?? null;
              if (latest) {
                lastCommitSigRef.current = feedSig(latest.newData, latest.newSchedule, latest.newState);
                lastLineupRef.current = lineupSig(latest.newData);
                applyTriple(latest, true);
              }
            };
            if (wait <= 0 || trackKey == null || lastTrackKeyRef.current == null) {
              if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
              commit();
            } else {
              if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
              promoteTimerRef.current = setTimeout(commit, wait);
            }
          } else if (promoteTimerRef.current || backendAhead) {
            // A promotion is held, or the backend queue already moved past
            // what is on display (-handed-over `sent` items). Committing now
            // would flip up-next-art early while now-playing-art still
            // (correctly) waits — stash only, the pending commit takes latest.
          } else {
            // Already promoted: skip identical re-polls entirely (no render,
            // no effect refires). Count-only updates apply silently; lineup
            // moves get the transition.
            const sig = feedSig(newData, newSchedule, newState);
            if (sig === lastCommitSigRef.current && lastTrackKeyRef.current !== null) {
              // stash only — pending commit takes latest
            } else {
              const lineup = lineupSig(newData);
              const moved = lineup !== lastLineupRef.current;
              lastLineupRef.current = lineup;
              lastCommitSigRef.current = sig;
              applyTriple({ newData, newSchedule, newState }, moved);
            }
          }

        } catch (e) {
          plog.error("station feed unreachable", e instanceof Error ? e.message : e);
        }
        if (isCancelled) return;
        if (backendOk) {
          if (backendFailRef.current >= 3) plog.info("backend reachable again");
          backendFailRef.current = 0;
          setBackendDown(false);
        } else {
          backendFailRef.current += 1;
          plog.warn("backend miss", { strike: backendFailRef.current });
          if (backendFailRef.current >= 3) setBackendDown(true);
        }
      };
      
      fetchStation();
      const interval = setInterval(fetchStation, 5000);
      return () => {
        isCancelled = true;
        clearInterval(interval);
        if (promoteTimerRef.current) clearTimeout(promoteTimerRef.current);
      };
  }, [status, session]);

  useEffect(() => {
    if (tourStep === -1) {
      setTooltipStyle(s => ({ ...s, opacity: 0 }));
      setTourSpot(null);
      return;
    }

    setTimeout(() => {
      const target = stepRefs.current[tourStep] || null;
      const placeSpot = () => {
        if (target && tourStep >= 1 && tourStep <= 8) {
          const r = target.getBoundingClientRect();
          setTourSpot({ top: r.top - 8, left: r.left - 8, width: r.width + 16, height: r.height + 16 });
        } else {
          setTourSpot(null);
        }
      };
      // Small screens: bottom sheet so the highlighted target stays visible
      // above it (a centered card covers exactly what it explains).
      if (typeof window !== "undefined" && window.innerWidth < 768 && tourStep >= 1) {
        if (target) {
          try { target.scrollIntoView({ block: "center" }); } catch {}
        }
        setTooltipStyle({
          top: 'auto',
          bottom: '24px',
          left: '16px',
          right: '16px',
          width: 'auto',
          transform: 'none',
          opacity: 1
        });
        // The sheet covers the bottom ~40% — nudge the target fully above it.
        requestAnimationFrame(() => {
          const card = document.getElementById("tour-card");
          const sheetTop = card
            ? card.getBoundingClientRect().top
            : window.innerHeight * 0.6;
          const r = target ? target.getBoundingClientRect() : null;
          if (r && r.bottom > sheetTop - 12) {
            window.scrollBy({ top: r.bottom - (sheetTop - 12), behavior: "auto" });
          }
          placeSpot();
        });
        return;
      }
      if (target && tourStep >= 1 && tourStep <= 8) {
        try { target.scrollIntoView({ block: 'nearest' }); } catch {}
        placeSpot();
        // Menu items anchor to the whole open menu: the tooltip needs the
        // menu's full footprint (below it), not the row's — otherwise the
        // card lands on top of the menu it describes.
        const menuEl = (target.closest && (target.closest('#user-menu') as HTMLElement | null)) || null;
        const rect = (menuEl || target).getBoundingClientRect();
        let top = rect.bottom + 20;
        let left = rect.left + (rect.width / 2);
        let transform = 'translateX(-50%)';

        // Check if it fits below
        if (top + 300 > window.innerHeight) {
          // Try above
          top = rect.top - 300;
        }

        // If it still goes off the top screen, or on small devices, just center it
        if (top < 20 || window.innerWidth < 768) {
          top = window.innerHeight / 2;
          left = window.innerWidth / 2;
          transform = 'translate(-50%, -50%)';
        } else {
          // Adjust if it goes off screen left/right
          if (left - 170 < 0) {
            left = 20;
            transform = 'none';
          } else if (left + 170 > window.innerWidth) {
            left = window.innerWidth - 360;
            transform = 'none';
          }
        }

        setTooltipStyle({
          top: `${top}px`,
          left: `${left}px`,
          width: '340px',
          transform,
          opacity: 1
        });
      } else {
        placeSpot();
        setTooltipStyle({
          top: '50%',
          left: '50%',
          width: '340px',
          transform: 'translate(-50%, -50%)',
          opacity: 1
        });
      }
    }, 50);
  }, [tourStep]);

  // Tour step 8 lives inside the user menu — open it (positioned) while there.
  useEffect(() => {
    if (tourStep < 0) return;
    if (tourStep === 8) openUserMenu();
    else setUserMenuOpen(false);
  }, [tourStep]);


  useEffect(() => {
    const fetchDirectLinks = async () => {
      const np = stationData?.nowPlaying;
      if (!np || !np.subsonic_id) return;
      
      // Reset links when song changes
      setDirectLinks({ spotify: null, apple: null });
      setTrackExplicit(false);

      try {
        const query = new URLSearchParams({
          trackId: np.subsonic_id,
          title: np.title,
          artist: np.artist,
          album: np.album || "",
          year: np.year ? String(np.year) : "",
        });
        const res = await fetch(`/api/links?${query.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setDirectLinks({
            spotify: data.spotifyUrl || null,
            apple: data.appleMusicUrl || null
          });
          if (data.explicit === true) setTrackExplicit(true);
          plog.info("links resolved", { track: np.title, spotify: !!data.spotifyUrl, apple: !!data.appleMusicUrl, explicit: data.explicit === true });
        } else {
          plog.warn("links failed", { status: res.status, track: np.title });
        }
      } catch (e) {
        plog.error("links unreachable", e instanceof Error ? e.message : e);
      }
    };
    
    fetchDirectLinks();
  }, [stationData?.nowPlaying?.subsonic_id]);

  useEffect(() => {
    const first = audioRef.current;
    if (!first) return;

    // All handlers close over the `audio` parameter, so the full set can
    // bind to whichever element is live — primary first, shadow after a swap.
    const bindAudio = (audio: HTMLAudioElement) => {

    const attemptPlay = () => {
        if (!intendedPlayRef.current) return;
        audio.src = streamSrc();
        plog.info("play attempt", { src: streamSrc() });
        audio.play().catch(e => {
          plog.error("play attempt rejected", { name: e?.name, message: e?.message });
          if (intendedPlayRef.current) setTimeout(attemptPlay, 2000);
        });
    };

    const clearBuffering = () => {
      if (bufferTimer.current) clearTimeout(bufferTimer.current);
      bufferTimer.current = null;
      setIsBuffering(false);
    };

    const markBuffering = () => {
      if (!intendedPlayRef.current || !hasAwakeRef.current || bufferTimer.current) return;
      bufferTimer.current = setTimeout(() => {
        bufferTimer.current = null;
        if (intendedPlayRef.current && hasAwakeRef.current) setIsBuffering(true);
      }, 400);
    };

    const handleAwake = () => {
      if (intendedPlayRef.current) {
        if (!hasAwakeRef.current) plog.info("audio awake", { src: audio.currentSrc || audio.src });
        hasAwakeRef.current = true;
        recoveringRef.current = false;
        setReconnecting(false);
        lastDataRef.current = Date.now();
        clearBuffering();
        setIsLoading(false);
        setIsPlaying(true);
        setIsAsleepWakeup(false);
      }
    };

    const handleProgress = () => {
      lastDataRef.current = Date.now();
    };
    handleAwakeRef.current = handleAwake;

    // Early recovery: reload at first silence instead of waiting for the
    // element's error (which lags far behind, per console). Cooldown-guarded
    // so a dead backend costs one attempt per 25s, not a hammer loop.
    const earlyRecover = (reason: string) => {
      if (recoveringRef.current || !intendedPlayRef.current) return;
      recoveringRef.current = true;
      setReconnecting(true);
      plog.warn("early reconnect", { reason, silentMs: Date.now() - lastDataRef.current });
      audio.src = streamSrc();
      audio.play().catch(e => {
        plog.error("early reconnect rejected", { name: e?.name, message: e?.message });
        if (e?.name === 'NotAllowedError') {
          intendedPlayRef.current = false;
          hasAwakeRef.current = false;
          recoveringRef.current = false;
          setReconnecting(false);
          clearBuffering();
          setIsPlaying(false);
          setIsLoading(false);
          setIsAsleepWakeup(false);
        }
      });
      setTimeout(() => {
        // Awake clears this sooner; the timeout only ends a failed attempt.
        if (recoveringRef.current) {
          recoveringRef.current = false;
          setReconnecting(false);
        }
      }, 25000);
    };
    earlyRecoverRef.current = earlyRecover;
    
    const handleTimeUpdate = () => {
      if (intendedPlayRef.current) {
        lastTimeRef.current = Date.now();
        handleAwake();
      }
    };
    
    const handleStalled = () => {
      // `stalled` fires on healthy live streams too: a paused element means
      // the stream dropped (full reconnect), otherwise it's a rebuffer worth
      // showing but not worth tearing down.
      if (!intendedPlayRef.current) return;
      if (!audio.paused) {
        markBuffering();
        return;
      }
      handleReconnect();
    };

    const handleWaiting = () => {
      // Pre-roll only. Safari fires `waiting` repeatedly on a healthy live
      // edge even while audio is audible — after first awake it must not
      // flip UI back to "Waking up".
      if (!intendedPlayRef.current) return;
      if (!hasAwakeRef.current) {
        setIsLoading(true);
        return;
      }
      markBuffering();
    };

    const handleReconnect = () => {
      if (intendedPlayRef.current) {
        // Hot path first: a buffered shadow takes over invisibly.
        if (swapToShadow()) return;
        const err = audio.error;
        plog.warn("stream dropped, reconnecting", {
          mediaErr: err ? { code: err.code, message: err.message } : null,
          paused: audio.paused,
          readyState: audio.readyState,
          networkState: audio.networkState,
        });
        hasAwakeRef.current = false;
        setIsLoading(true);
        audio.src = streamSrc();
        audio.play().catch(e => {
            plog.error("reconnect play() rejected", { name: e?.name, message: e?.message });
            if (e.name === 'NotAllowedError') {
                 // iOS blocked auto-play, must wait for user click
                 intendedPlayRef.current = false;
                 hasAwakeRef.current = false;
                 clearBuffering();
                 setIsPlaying(false);
                 setIsLoading(false);
                 setIsAsleepWakeup(false);
            } else {
                 setTimeout(attemptPlay, 2000);
            }
        });
      }
    };

    audio.addEventListener("playing", handleAwake);
    audio.addEventListener("canplay", handleAwake);
    audio.addEventListener("loadeddata", handleAwake);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("progress", handleProgress);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("error", handleReconnect);
    audio.addEventListener("ended", handleReconnect);
    audio.addEventListener("stalled", handleStalled);

    return () => {
      audio.removeEventListener("playing", handleAwake);
      audio.removeEventListener("canplay", handleAwake);
      audio.removeEventListener("loadeddata", handleAwake);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("progress", handleProgress);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("error", handleReconnect);
      audio.removeEventListener("ended", handleReconnect);
      audio.removeEventListener("stalled", handleStalled);
    };
    }; // bindAudio

    let unbindActive: (() => void) | null = null;

    const dropShadow = (cooldown: boolean) => {
      const sh = shadowRef.current;
      shadowRef.current = null;
      if (cooldown) lastShadowDropRef.current = Date.now();
      if (sh) {
        try { sh.pause(); sh.removeAttribute("src"); sh.load(); } catch {}
      }
    };

    // Background pre-connect: buffer the same stream silently. Never played
    // until a swap — no echo risk. Cooldown-guarded after failures.
    const buildShadow = (reason: string) => {
      if (shadowRef.current || !intendedPlayRef.current) return;
      if (Date.now() - lastShadowDropRef.current < 25000) return;
      const sh = new Audio();
      sh.preload = "auto";
      shadowBornRef.current = Date.now();
      plog.info("shadow pre-connect", { reason });
      sh.addEventListener("canplay", () => plog.info("shadow ready", { readyState: sh.readyState }), { once: true });
      sh.addEventListener("error", () => {
        plog.warn("shadow failed, dropping");
        if (shadowRef.current === sh) dropShadow(true);
      });
      shadowRef.current = sh;
      sh.src = streamSrc();
    };

    // Hot swap to a buffered shadow. Keeps awake state — the point is the
    // listener never notices. Returns false when no usable shadow exists.
    const swapToShadow = () => {
      const sh = shadowRef.current;
      const old = audioRef.current;
      if (!sh || !old || sh === old || sh.readyState < 3) return false;
      plog.warn("hot swap to shadow", { readyState: sh.readyState });
      try { old.pause(); } catch {}
      try { old.removeAttribute("src"); old.load(); } catch {}
      unbindActive?.();
      shadowRef.current = null;
      audioRef.current = sh;
      unbindActive = bindAudio(sh);
      lastDataRef.current = Date.now();
      lastTimeRef.current = Date.now();
      setReconnecting(false);
      recoveringRef.current = false;
      sh.play().catch(e => {
        plog.error("shadow play rejected", { name: e?.name, message: e?.message });
      });
      return true;
    };

    unbindActive = bindAudio(first);

    // Safari on live streams sometimes never fires playing/canplay/timeupdate
    // even while audio is audible. Poll element state as backstop: audible
    // means readyState >= HAVE_CURRENT_DATA and not paused.
    // Same tick is the watchdog: playback advancing (timeupdate) with no new
    // bytes (progress) means the buffer is draining — pre-connect a shadow.
    // Total silence still falls back to earlyRecover.
    const awakeTimer = setInterval(() => {
      const el = audioRef.current;
      if (!el) return;
      if (
        intendedPlayRef.current &&
        !hasAwakeRef.current &&
        !el.paused &&
        el.readyState >= 2
      ) {
        handleAwakeRef.current?.();
      }
      const now = Date.now();
      const playing = intendedPlayRef.current && hasAwakeRef.current;
      const advancing = now - lastTimeRef.current < 2500;
      const dry = lastDataRef.current > 0 && now - lastDataRef.current > 5000;
      if (playing && advancing && dry && !shadowRef.current) {
        buildShadow(backendDownRef.current ? "backend down" : "buffer draining");
      }
      if (shadowRef.current && now - shadowBornRef.current > 90000) {
        dropShadow(false);
      }
      if (
        playing &&
        !recoveringRef.current &&
        lastDataRef.current > 0 &&
        now - lastDataRef.current > 12000
      ) {
        earlyRecoverRef.current?.(backendDownRef.current ? "backend down" : "no data 12s");
      }
    }, 2000);

    return () => {
      clearInterval(awakeTimer);
      if (bufferTimer.current) { clearTimeout(bufferTimer.current); bufferTimer.current = null; }
      setIsBuffering(false);
      unbindActive?.();
      unbindActive = null;
      dropShadow(false);
      earlyRecoverRef.current = null;
      handleAwakeRef.current = null;
    };
  }, [isApprovedPlayer]);

  // Skip: everyone sees the button; it fires when solo (admins always).
  //
  // Two independent locks, and the second one is the important one:
  //
  // 1. Post-skip cooldown — right after a cut the display still shows the
  //    OLD track until the delayed promotion commits, so a second press
  //    would land on the wrong song.
  // 2. End-of-track lock — once the displayed track has <= bufferSeconds
  //    left, the next track is already buffered and on its way. Skipping
  //    there cuts into it and desyncs the display from the audio, so the
  //    button goes dead and says so.
  //
  // Skipping at the START of a track is fine and stays enabled.
  // Every buffer read goes through here. The value is owned by the Sub/Wave
  // host and arrives on /api/now-playing as stream.bufferSeconds; the fallback
  // only covers the window before the first successful feed poll. There is no
  // buffer setting in this app — changing it means changing it in Sub/Wave.
  const streamBufferSec = () => {
    const b = stationData?.stream?.bufferSeconds;
    return typeof b === "number" && Number.isFinite(b) && b >= 0 ? b : 22;
  };

  const startSkipCooldown = () => {
    const secs = streamBufferSec() + 15;
    if (skipCooldownTimer.current) clearInterval(skipCooldownTimer.current);
    setSkipCooldownLeft(secs);
    skipCooldownTimer.current = setInterval(() => {
      setSkipCooldownLeft(left => {
        if (left <= 1) {
          if (skipCooldownTimer.current) clearInterval(skipCooldownTimer.current);
          skipCooldownTimer.current = null;
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };

  const adminSkipTrack = async () => {
    const np = stationData?.nowPlaying;
    if (!np?.title || adminBusy || skipCooldownLeft > 0) return;
    // Refuse inside the end-of-track window even if the UI was bypassed.
    if (skipLocked) return;
    const listeners = stationData?.listeners?.current;
    const isAdmin = !!(session?.user as any)?.isAdmin;
    // Cutting for company needs a confirm; solo skips go straight through.
    //
    // Under "always show" a listener IS allowed to cut with company, so they get
    // the same confirm an admin does. This used to return silently, which under
    // "always" would leave a button that does nothing when pressed. Under the
    // other two modes the server refuses regardless, so there is nothing to fix.
    if (typeof listeners === "number" && listeners > 1 && !isAdmin && skipVisibility !== "always") return;
    if (typeof listeners === "number" && listeners > 1) {
      if (!window.confirm(`Skip "${np.title}" for every listener?`)) return;
    }
    setAdminBusy("skip");
    setAdminAck("");
    setAdminAckShow(false);
    try {
      plog.info("skip out");
      const res = await fetch("/api/skip", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      plog.info("skip response", { status: res.status, data });
      if (res.ok) {
        flashAdminAck("Skipped.");
        startSkipCooldown();
      } else {
        flashAdminAck(data.error || "Skip failed.");
      }
    } catch {
      flashAdminAck("Skip failed.");
    } finally {
      setAdminBusy(null);
    }
  };

  // Seconds left on the DISPLAYED track, from the listener's side. The
  // backend timestamp is when the track hit the wire; the listener hears it
  // bufferSeconds later, so that is when the song actually ends for them.
  const [trackRemaining, setTrackRemaining] = useState<number | null>(null);
  useEffect(() => {
    const np = stationData?.nowPlaying;
    if (!np?.timestamp || trackDuration == null) {
      setTrackRemaining(null);
      return;
    }
    const audibleEnd = Number(np.timestamp) + streamBufferSec() + (trackDuration as number);
    const update = () => {
      // A discredited duration reports null, not 0: locking skip against a
      // number we no longer believe would disable the button for no reason, and
      // the tooltip would read "-0s left" on a song still playing.
      const raw = audibleEnd - Math.floor(Date.now() / 1000);
      setTrackRemaining(isDurationDiscredited(raw) ? null : Math.max(0, raw));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [stationData?.nowPlaying?.timestamp, trackDuration, stationData?.stream?.bufferSeconds]);

  // The end-of-track lock: once the displayed track has no more than
  // bufferSeconds left, the next song is already buffered and inbound, so a
  // skip there would cut into it and desync the display from the audio.
  const skipLocked = trackRemaining !== null && trackRemaining <= streamBufferSec();

  // Sync now playing metadata to OS media controls (Lock Screen / Control Center).
  // MediaMetadata has no explicit field (title/artist/album/artwork only), so
  // explicit tracks get a 🅴 title suffix when the admin toggle is on. The
  // Spotify lookup lands async after first paint — trackExplicit re-fires this.
  // Guarded by applied key: feed polls hand fresh objects, re-setting the
  // same metadata every 5s (and spamming the log) is pure waste.
  //
  // Position state (the progress bar and remaining time) is NOT under the key
  // guard — it has to be re-set as the clock ticks, every second while a track is
  // playing. Same for the action handlers, which follow live button state.
  const mediaAppliedRef = useRef<string | null>(null);
  // Whether a lock-screen press would do exactly what the in-app Skip button does.
  // The in-app button confirms when other listeners are present ("skip for every
  // listener?"), and a lock screen cannot ask — so the handler is only registered
  // when no confirm would be needed. Otherwise the button is removed (handler set
  // to null) rather than left to dead-end. skipEnabled mirrors the in-app
  // disabled state (cooldown, end-of-track lock, an action already running),
  // and adminSkipTrack re-checks all of this itself, so a stale registration
  // cannot skip something the UI would refuse.
  const lockScreenSkipOn = (() => {
    const listeners = stationData?.listeners?.current;
    const isAdmin = !!(session?.user as any)?.isAdmin;
    const shown = isAdmin || canSkipAsListener(skipVisibility, listeners);
    const cooling = skipCooldownLeft > 0;
    const enabled = !cooling && !skipLocked && adminBusy === null;
    const needsConfirm = typeof listeners === "number" && listeners > 1;
    return shown && enabled && !needsConfirm && !!stationData?.nowPlaying?.title;
  })();
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : isLoading || isBuffering ? "paused" : "none";
    } catch {}
    if (lockScreenSkipOn) {
      try {
        navigator.mediaSession.setActionHandler("nexttrack", () => { void adminSkipTrack(); });
      } catch {}
    } else {
      try {
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {}
    }
    try {
      navigator.mediaSession.setActionHandler("play", () => { if (!isPlaying) togglePlay(); });
    } catch {}
    try {
      navigator.mediaSession.setActionHandler("pause", () => { if (isPlaying) togglePlay(); });
    } catch {}
    const np = stationData?.nowPlaying;
    if (np) {
      const artworkUrl = np.subsonic_id
        ? `${STATION_API}/api/cover/${np.subsonic_id}`
        : `${window.location.origin}${STATION.logo}`;
      const title = np.title || `${stationName} Live`;
      const suffixed = trackExplicit && explicitSuffix ? `${title} 🅴` : title;
      const key = `${np.subsonic_id}|${suffixed}|${np.artist}|${np.album}|${artworkUrl}`;
      if (key !== mediaAppliedRef.current) {
        mediaAppliedRef.current = key;
        if (trackExplicit) plog.info("lock screen explicit tag", { title, suffix: explicitSuffix });
        navigator.mediaSession.metadata = new MediaMetadata({
          title: suffixed,
          artist: np.artist || stationName,
          album: np.album || stationName,
          artwork: [
            { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '512x512', type: 'image/png' }
          ]
        });
      }
      // Remaining time, from the same clock the on-screen countdown uses: the
      // backend timestamp is when the track hit the wire and the listener hears it
      // bufferSeconds later, so elapsed starts there. Clamped into range — a
      // position outside [0, duration] makes setPositionState throw, and a track
      // with no usable numbers simply gets no position rather than a wrong one.
      try {
        // trackDuration is the resolved length (now-playing or history) — the
        // same value the countdown shows, so the lock screen never disagrees.
        const duration = trackDuration as number | null;
        const elapsed = Math.floor(Date.now() / 1000) - (Number(np.timestamp) + streamBufferSec());
        // Both halves have to be numbers. A track with no timestamp (a live edge
        // with nothing countable) makes elapsed NaN, and NaN clamps to NaN — which
        // makes setPositionState throw. The try/catch would swallow it, but once a
        // second, forever, so the check belongs here instead.
        // A discredited duration also drops the position bar: pinning it at full
        // while the song keeps playing is the lock-screen version of -0:00 stuck.
        if (duration != null && Number.isFinite(duration) && duration > 0 && Number.isFinite(elapsed) && !isDurationDiscredited(duration - elapsed)) {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position: Math.min(Math.max(elapsed, 0), duration),
          });
        }
      } catch {}
    } else {
      const defaultArtwork = `${window.location.origin}${STATION.logo}`;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Ready to Broadcast',
        artist: stationName,
        album: stationName,
        artwork: [
          { src: defaultArtwork, sizes: '512x512', type: 'image/png' }
        ]
      });
    }
  }, [stationData?.nowPlaying, trackExplicit, explicitSuffix, stationName, trackRemaining, trackDuration, lockScreenSkipOn, isPlaying, isLoading, isBuffering]);

  const adminBlockTrack = async (type: "track" | "album" | "artist") => {
    const np = stationData?.nowPlaying;
    if (!np?.subsonic_id || adminBusy) return;
    setBlockMenuOpen(false);
    setAdminBusy("block");
    setAdminAck("");
    setAdminAckShow(false);
    try {
      plog.info("block out", { type, trackId: np.subsonic_id });
      const res = await fetch("/api/admin/block-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, trackId: np.subsonic_id }),
      });
      const data = await res.json().catch(() => ({}));
      plog.info("block response", { status: res.status, data });
      if (res.ok) {
        const what = type === "track" ? `"${np.title}"` : type === "album" ? `album "${np.album}"` : np.artist;
        flashAdminAck(`${what} will never air${data.purged ? ` · ${data.purged} dropped from queue` : ""}. Current play finishes unless skipped.`);
      } else {
        flashAdminAck(data.error || "Block failed.");
      }
    } catch {
      flashAdminAck("Block failed.");
    } finally {
      setAdminBusy(null);
    }
  };

  useEffect(() => () => {
    if (skipCooldownTimer.current) clearInterval(skipCooldownTimer.current);
    if (reqCooldownTimer.current) clearInterval(reqCooldownTimer.current);
  }, []);

  // Admin push alerts: register the worker and subscribe this device so new
  // access requests ping the homescreen app. Retries each fresh login.
  const pushSubscribedRef = useRef(false);
  useEffect(() => {
    if (status === "unauthenticated") {
      pushSubscribedRef.current = false;
      return;
    }
    if (status !== "authenticated" || !(session?.user as any)?.isAdmin) return;
    if (pushSubscribedRef.current) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    pushSubscribedRef.current = true;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        // Never prompt without a gesture — browsers log an error and ignore
        // it. Grant via the browser site settings (or the admin Enable
        // button), then this subscribes silently on next login.
        if (Notification.permission !== "granted") {
          plog.info("push skipped — notification permission not granted");
          return;
        }
        const cfg = await fetch("/api/push/config").then(r => r.json());
        if (!cfg.publicKey) return;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: cfg.publicKey,
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
        });
      } catch (e) {
        plog.error("push subscribe failed", e instanceof Error ? e.message : e);
      }
    })();
  }, [status, session]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) {
      plog.error("audio element not mounted");
      return;
    }

    if (intendedPlayRef.current) {
      intendedPlayRef.current = false;
      plog.info("stop pressed");
      hasAwakeRef.current = false;
      recoveringRef.current = false;
      setReconnecting(false);
      const sh = shadowRef.current;
      shadowRef.current = null;
      if (sh) { try { sh.pause(); sh.removeAttribute("src"); sh.load(); } catch {} }
      hasAwakeRef.current = false;
      if (bufferTimer.current) { clearTimeout(bufferTimer.current); bufferTimer.current = null; }
      setIsBuffering(false);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setIsPlaying(false);
      setIsLoading(false);
      setIsAsleepWakeup(false);
    } else {
      intendedPlayRef.current = true;
      hasAwakeRef.current = false;
      setIsLoading(true);
      const listeners = stationData?.listeners?.current || 0;
      if (listeners === 0) {
        setIsAsleepWakeup(true);
      }

      audio.src = streamSrc();
      plog.info("play pressed", { src: streamSrc(), listeners });
      audio.play().catch(e => {
        plog.error("play() rejected", { name: e?.name, message: e?.message });
        if (intendedPlayRef.current) {
           if (e.name === 'NotAllowedError') {
               intendedPlayRef.current = false;
               hasAwakeRef.current = false;
               if (bufferTimer.current) { clearTimeout(bufferTimer.current); bufferTimer.current = null; }
               setIsBuffering(false);
               setIsPlaying(false);
               setIsLoading(false);
               setIsAsleepWakeup(false);
           } else {
               setTimeout(() => {
                 if (intendedPlayRef.current && audioRef.current) {
                   audioRef.current.src = streamSrc();
                   audioRef.current.play().catch(() => {});
                 }
               }, 2000);
           }
        }
      });
    }
  };

  useEffect(() => {
    if (status !== "authenticated" || !session) return;
    if ((session.user as any)?.isApproved || accessDenied) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/me");
        if (res.status === 404 || res.status === 401) {
          setAccessDenied(true);
          clearInterval(id);
          return;
        }
        if (!res.ok) return;
        const me = await res.json();
        if (me.isApproved) window.location.reload();
      } catch {}
    }, 10000);
    return () => clearInterval(id);
  }, [status, session, accessDenied]);

  useEffect(() => {
    if (!pendingReqId) return;

    let pollFails = 0;
    let gaveUp = false;
    let waited = 0;

    const finish = (ack: string) => {
      if (gaveUp) return;
      gaveUp = true;
      setReqAck(ack);
      setPendingReqId(null);
      setReqStage("idle");
      setReqWaitSecs(0);
      // The cooldown starts only now — once we know how it turned out. Starting it
      // on submit meant a listener who got no answer at all could not retry for
      // thirty seconds with no idea why the button was dead.
      startReqCooldown(30);
    };

    const poll = async () => {
      if (gaveUp) return;
      try {
        const res = await fetch(`/api/request?id=${pendingReqId}`, { cache: "no-store" });
        if (!res.ok) {
          // A transient blip is not a broken request. A run of them is, and saying
          // so is better than either pretending it is fine or abandoning a request
          // that is very likely still queued.
          if (++pollFails >= 3) {
            finish("Something went wrong checking with the booth. Your request was sent — try again in a moment.");
          }
          return;
        }
        pollFails = 0;
        const data = await res.json();
        if (data.status === "resolved" || data.success) {
          finish(data.ack || "Got you — your request is coming up.");
        } else if (data.status === "rejected" || data.status === "unknown") {
          finish(data.message || "Sorry, the DJ couldn’t schedule that one right now.");
        }
      } catch (e) {
        plog.error("request status poll failed", e instanceof Error ? e.message : e);
        if (++pollFails >= 3) {
          finish("Lost contact while checking with the booth. Your request was sent — try again in a moment.");
        }
      }
    };

    const pollId = setInterval(poll, 5000);

    // The clock behind the escalating message, and the deadline under it. Both live
    // here so they cannot drift apart: the message cannot say "struggling" without
    // the timeout being the thing that actually stops the waiting.
    //
    // The elapsed count is a plain closure variable rather than a setState
    // updater. An updater has to be pure, and doing setReqAck() inside one is not:
    // React decides when to run it, so the ack was being written a second time
    // after the booth had already answered — a resolved request showed "still
    // checking with the DJ" instead of the DJ's reply.
    const tickId = setInterval(() => {
      if (gaveUp) return;
      const next = waited + 1;
      waited = next;
      if (next >= REQUEST_TIMEOUT_SEC) {
        // Out of patience, not out of queue: the request is still on the booth's
        // list, and saying so is the honest end to this.
        finish(REQUEST_TIMEOUT_MESSAGE);
        return;
      }
      setReqWaitSecs(next);
      setReqAck(requestWaitMessage(next));
    }, 1000);

    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [pendingReqId]);


  const submitRequest = async () => {
    if (!reqSong || reqStage !== "idle" || reqCooldownLeft > 0) return;
    setReqAck("");
    setReqStage("posting");
    try {
      plog.info("request out", { track: reqSong, name: reqName || "Anonymous Listener" });
      const res = await fetch("/api/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track: reqSong,
          name: reqName,
        })
      });
      const data = await res.json().catch(() => ({}));
      plog.info("request response", { status: res.status, data });

      // A 500 or anything else that is not a rate limit means the request may not
      // have reached the booth at all. Say so plainly rather than implying it did.
      if (!res.ok && res.status !== 429) {
        setReqStage("idle");
        setReqAck("Something went wrong sending that — it may not have reached the booth. Try again in a moment.");
        startReqCooldown(30);
        return;
      }

      if (res.status === 429) {
        setReqStage("idle");
        setReqAck(data.error || "The booth is taking too many requests right now — try again shortly.");
        startReqCooldown(typeof data.retryAfterSec === "number" ? data.retryAfterSec : 30);
        return;
      }

      setReqSong("");

      if (data.requestId && data.status === "pending") {
        // Accepted. The booth still has to answer, and until it does nobody knows
        // whether the request will be played — so the cooldown waits for that rather
        // than starting now, and the message says what is actually happening.
        setPendingReqId(data.requestId);
        setReqWaitSecs(0);
        setReqStage("waiting");
        setReqAck(requestWaitMessage(0));
      } else {
        // Answered inline, so the booth already told us.
        setReqStage("idle");
        setReqAck(data.message || data.ack || data.error || "Request sent to the booth.");
        startReqCooldown(30);
      }
    } catch (e) {
      plog.error("request submit failed", e instanceof Error ? e.message : e);
      setReqStage("idle");
      setReqAck("Something went wrong sending that — the station could not be reached. Try again in a moment.");
      startReqCooldown(30);
    }
  };


  const advanceTour = () => {
    if (tourStep >= 9) {
      setTourStep(-1);
      localStorage.setItem("hasSeenTour", "true");
    } else {
      setTourStep(t => t + 1);
    }
  };

  const submitSay = async () => {
    const text = sayText.trim();
    if (!text || sayBusy) return;
    setSayAck("");
    setSayAckShow(false);
    setSayBusy(true);
    try {
      plog.info("say out", { chars: text.length, mode: sayMode, kind: sayKind });
      const res = await fetch("/api/admin/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode: sayMode, kind: sayKind }),
      });
      const data = await res.json().catch(() => ({}));
      plog.info("say response", { status: res.status, spoken: (data as any)?.spoken, error: (data as any)?.error });
      if (res.ok) {
        flashSayAck(data.spoken ? `On air: "${data.spoken}"` : "Sent to air.");
        setSayText("");
      } else {
        const raw = data.error || "Send failed.";
        // Backend LLM flake ("Invalid JSON response") airs nothing — keep it
        // plain so retry is obvious. Text stays for one more tap.
        flashSayAck(/invalid json/i.test(raw)
          ? "Station brain glitch — nothing aired. Hit Send to air again."
          : raw);
      }
    } catch {
      flashSayAck("Failed to reach station backend.");
    } finally {
      setSayBusy(false);
    }
  };

  if (status === "loading") {
    return <div className="container centered-column" style={{ justifyContent: "center" }}>Loading...</div>;
  }

  // State 1: Unauthenticated
  if (!session) {
    const showName = stationData?.activeShow?.name;
    const onAirName = stationData?.activeShow?.persona?.name || stationData?.dj?.name;

    return (
      <main id="main-unauth" className="container centered-column" style={{ justifyContent: "center", gap: "2rem" }}>
        {/* Banner Block */}
        <div id="unauth-on-air" style={{ textAlign: "center", background: "rgba(0,0,0,0.73)", padding: "2rem", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)", display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div id="logo-container-unauth">
            <Image id="logo-img-unauth" src={STATION.logo} alt={stationName} width={400} height={80} className="logo-img" style={{ margin: '0 auto', filter: "drop-shadow(0px 4px 12px rgba(0,0,0,0.6))" }} priority />
            <p id="tagline-unauth" className="tagline" style={{ marginTop: '0.5rem' }}>{STATION.tagline}</p>
          </div>

          {/* Current Show Info */}
          {(showName || onAirName) && (
            <div id="unauth-on-air-info" style={{ marginTop: "0.5rem", paddingTop: "1.5rem", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
              <div style={{ fontSize: "0.9rem", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "0.5rem" }}>On The Air Now</div>
              <div style={{ fontSize: "1.2rem", color: "#fff", fontWeight: 600 }}>
                {showName && <span>{showName}</span>}
                {showName && onAirName && <span style={{ margin: "0 8px", color: "var(--color-muted)" }}>•</span>}
                {onAirName && <span style={{ color: "var(--color-accent)" }}>with {onAirName}</span>}
              </div>
            </div>
          )}
        </div>

        <div id="card-unauth" className="card" style={{ maxWidth: "500px", width: "100%" }}>
          <h2 style={{ marginBottom: "1rem", fontSize: "1.3rem", textAlign: "center", color: "#fff" }}>About the Station</h2>
          <p id="about-text-unauth" className="about-text" style={{ marginBottom: "2rem", textAlign: "center", lineHeight: "1.6" }}>
            {STATION.about}
          </p>
          <button id="btn-signin" onClick={() => signIn("google")} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", backgroundColor: "#fff", color: "#1f1f1f", border: "1px solid #747775", borderRadius: "20px", height: "44px", padding: "0 16px", width: "100%", marginBottom: "1rem", fontFamily: "Roboto, Arial, sans-serif", fontSize: "15px", fontWeight: 500, cursor: "pointer" }}>
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            Sign in with Google
          </button>
          {donateEnabled && donateUrl ? (
          <a id="btn-support-unauth" href={donateUrl} target="_blank" rel="noreferrer" className="donate-btn" style={{ display: "block", textAlign: "center" }}>
            {donateText}
          </a>
          ) : null}
        </div>
      </main>
    );
  }

  // State 2: Authenticated but Pending Approval
  if (!(session.user as any)?.isApproved) {
    return (
      <main id="main-pending" className="container centered-column" style={{ justifyContent: "center" }}>
        <div id="logo-container-pending">
          <Image id="logo-img-pending" src={STATION.logo} alt={stationName} width={400} height={80} className="logo-img" style={{ margin: '0 auto', filter: "drop-shadow(0px 4px 12px rgba(0,0,0,0.6))" }} priority />
          <p id="tagline-pending" className="tagline" style={{ marginTop: '1rem' }}>{STATION.tagline}</p>
        </div>
        <div id="card-pending" className="card">
          {accessDenied ? (
            <>
              <p id="about-text-denied" className="about-text" style={{ marginBottom: "2rem" }}>
                <strong>Access denied.</strong><br/><br/>
                This account no longer has access to the station.
              </p>
              <button id="btn-signout-denied" className="primary-btn" onClick={() => signOut({ callbackUrl: "/" })}>Sign out</button>
            </>
          ) : (
            <>
              <p id="about-text-pending" className="about-text" style={{ marginBottom: "2rem" }}>
                <strong>Your account is pending approval.</strong><br/><br/>
                The station owner will review your request shortly. This screen lets you in automatically once approved.
              </p>
              <button id="btn-signout-pending" className="primary-btn" onClick={() => signOut({ callbackUrl: "/" })}>Sign out</button>
            </>
          )}
        </div>
      </main>
    );
  }

  // Resolve avatars via the /api proxy on the station's NextJS frontend
  const getAvatarSrc = (avatarPath: string) => {
    if (!avatarPath) return "";
    if (avatarPath.startsWith("http")) return avatarPath;
    // Ensure the path has /api prefix
    const normalizedPath = avatarPath.startsWith("/api/")
      ? avatarPath
      : `/api${avatarPath.startsWith("/") ? "" : "/"}${avatarPath}`;
    return `${STATION_API}${normalizedPath}`;
  };

  // Helper for rendering avatars
  const renderAvatars = () => {
    const p = stationData?.activeShow?.persona || stationData?.dj;
    const guests = stationData?.activeShow?.guests || [];

    return (
      <div id="avatars-container" ref={el => { stepRefs.current[5] = el; }} className="avatars" style={{ marginTop: "1rem", display: "flex", gap: "1rem", alignItems: "center", position: tourStep === 5 ? "relative" : "static", zIndex: tourStep === 5 ? 1000 : 1 }}>
        {p ? (
          <button
            id="avatar-host-container"
            type="button"
            onClick={() => setShowHost({ name: p.name, avatar: getAvatarSrc(p.avatar), role: "Host", tagline: p.tagline })}
            aria-label={`About ${p.name}`}
            title={`About ${p.name}`}
            style={{ display: "flex", alignItems: "center", gap: "1rem", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
          >
            <img id="avatar-host-img" src={getAvatarSrc(p.avatar)} alt={p.name} className="avatar" title={p.name} style={{ width: "64px", height: "64px" }} />
            <div id="avatar-host-text-container">
              <strong id="avatar-host-name">{p.name}</strong>
              <div id="avatar-host-role" style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>Host</div>
            </div>
          </button>
        ) : (
          <div id="avatar-autodj-container" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <Image id="avatar-autodj-img" src={STATION.logo} alt="Auto DJ" className="avatar" title="Auto DJ" style={{ width: "64px", height: "64px", objectFit: "contain", background: "rgba(0,0,0,0.2)" }} width={64} height={64} />
            <div id="avatar-autodj-text-container">
              <strong id="avatar-autodj-name">Auto DJ</strong>
              <div id="avatar-autodj-role" style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>Host</div>
            </div>
          </div>
        )}
        {guests.map((g: any, index: number) => (
          <button
            id={`avatar-guest-container-${index}`}
            key={g.id}
            type="button"
            onClick={() => setShowHost({ name: g.name, avatar: getAvatarSrc(g.avatar), role: "Guest", tagline: g.tagline })}
            aria-label={`About ${g.name}`}
            title={`About ${g.name}`}
            style={{ display: "flex", alignItems: "center", gap: "1rem", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
          >
            <img id={`avatar-guest-img-${index}`} src={getAvatarSrc(g.avatar)} alt={g.name} className="avatar" title={g.name} style={{ width: "64px", height: "64px" }} />
            <div id={`avatar-guest-text-container-${index}`}>
              <strong id={`avatar-guest-name-${index}`}>{g.name}</strong>
              <div id={`avatar-guest-role-${index}`} style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>Guest</div>
            </div>
          </button>
        ))}
      </div>
    );
  };

  const getNextSong = () => {
    return appStateData?.upcoming?.[0] || null;
  };
  const hasVisibleNextShow = tourStep === 4 || (isPlaying && getNextSong());

  // State 3: Approved Player
  
  const showName = stationData?.activeShow?.name;
  const onAirName = stationData?.activeShow?.persona?.name || stationData?.dj?.name;
  const nextShow = stationData?.context?.showHandover?.nextShow;
  const nextShowText = nextShow ? `Until ${nextShow.startsAt}` : null;

  // Show runway from the weekly grid: when the current show ends + what
  // follows. Grid keys are station-zone JS weekdays ('0' = Sunday) of hourly
  // show ids; show/host names resolve off the schedules lists. All arithmetic
  // runs in station wall-clock minutes, converted to an epoch only at the end.
  const showRunway = (() => {
    try {
      const grid = scheduleData?.schedule;
      const shows = scheduleData?.shows;
      const personas = scheduleData?.personas;
      const tz = scheduleData?.timezone;
      if (!grid || !shows || !tz) return null;
      const parts: Record<string, string> = {};
      for (const p of new Intl.DateTimeFormat("en-AU", {
        timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
      }).formatToParts(new Date())) parts[p.type] = p.value;
      const dayKeys = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const day = dayKeys.indexOf(parts.weekday);
      const hour = parseInt(parts.hour, 10) % 24;
      const minute = parseInt(parts.minute, 10) % 60;
      if (day < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      const idAt = (d: number, h: number) => {
        const row = grid[String(((d % 7) + 7) % 7)];
        return Array.isArray(row) ? row[((h % 24) + 24) % 24] : null;
      };
      const curId = idAt(day, hour);
      if (!curId) return null;
      let d = day, h = hour, guard = 0;
      do { h++; if (h >= 24) { h = 0; d++; } guard++; }
      while (guard < 72 && idAt(d, h) === curId);
      if (guard >= 72) return null;
      const nowMin = (day * 24 + hour) * 60 + minute;
      const endMin = (d * 24 + h) * 60;
      const leftMin = Math.max(endMin - nowMin, 1);
      const showById = (id: string) => (shows as any[]).find((s: any) => s.id === id);
      const nextShowObj = idAt(d, h) ? showById(idAt(d, h)) : null;
      const nextHost = nextShowObj
        ? (personas as any[])?.find((p: any) => p.id === nextShowObj.personaId)?.name || null
        : null;
      return {
        endMs: Date.now() + leftMin * 60000,
        leftMin,
        nextName: nextShowObj?.name || null,
        nextHost,
        tz,
      };
    } catch {
      return null;
    }
  })();

  const fmtDurLeft = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  };
  const fmtClock = (ms: number, tz: string) => {
    try {
      return new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(ms));
    } catch {
      return "";
    }
  };
  
  // Extract weather and mood/vibe from context for the header
  const weatherCond = stationData?.context?.weather?.condition;
  const weatherTemp = stationData?.context?.weather?.temp;
  const showVibe = stationData?.context?.time?.vibe || stationData?.context?.festival?.mood;

  return (
    <main id="main-player" className="container" style={{ paddingTop: "2rem", overflowX: "clip" }}>

      <header id="header-player" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "3rem" }}>
        <div id="header-logo-container">
          <Image id="header-logo-img" src={STATION.logo} alt={stationName} width={300} height={60} className="logo-img" style={{ filter: "drop-shadow(0px 4px 12px rgba(0,0,0,0.6))" }} priority />
        </div>
          
        {/* The three header chips. Wrapped rather than allowed to overflow, so a
            narrow screen costs a second line rather than clipped items. */}
        <div id="header-chips" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          {/* Operator toggles, Admin → Station → Header. Each is removed from
              the DOM rather than hidden, so nothing is fetched or announced for a
              chip that is off. */}
          {headerListeners && (
            <div id="header-listeners" className="header-chip">
              <UserIcon /> {signedInCount ?? "–"} signed in, {stationData?.listeners?.current ?? 0} listening
            </div>
          )}
          
          {(headerWeather && weatherCond && weatherCond !== 'unknown') && (
            <div id="header-weather" className="header-chip">
              <WeatherIcon condition={weatherCond} />
              <span>{Number.isFinite(weatherTemp) ? `${weatherTemp}° ` : ''}<span style={{ textTransform: "capitalize" }}>{weatherCond}</span></span>
            </div>
          )}
          
          {(headerVibe && showVibe) && (
            <div id="header-vibe" className="header-chip" style={{ textTransform: "capitalize" }}>
              {showVibe}
            </div>
          )}
        </div>
        <div id="header-actions" style={{ position: "relative" }}>
          <button
            id="btn-user-menu"
            ref={(el) => { userMenuBtnRef.current = el; stepRefs.current[7] = el; }}
            onClick={() => (userMenuOpen ? setUserMenuOpen(false) : openUserMenu())}
            aria-expanded={userMenuOpen}
            aria-haspopup="true"
            title="Account"
            className="header-chip header-chip-btn"
            style={{ position: tourStep === 7 ? "relative" : "static", zIndex: tourStep === 7 ? 1000 : 1 }}
          >
            <UserIcon />
            Account
          </button>
          {userMenuOpen && (
            <>
              <div id="user-menu-backdrop" onClick={() => setUserMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1190 }} />
              <div id="user-menu" role="menu" ref={userMenuElRef} className="overlay-card-enter" style={{ position: "fixed", top: userMenuPos ? `${userMenuPos.top}px` : "76px", left: userMenuPos ? `${userMenuPos.left}px` : "8px", zIndex: 1200, width: "260px", maxWidth: "calc(100vw - 16px)", backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "12px", padding: "0.5rem", boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}>
                <div style={{ padding: "0.5rem 0.75rem", fontSize: "0.85rem", color: "var(--color-muted)", borderBottom: "1px solid var(--color-border)", marginBottom: "0.25rem" }}>
                  {/* Never fall back to session.user.email — that is a blind
                      index token, not the address. */}
                  Signed in as<br /><strong style={{ color: "var(--color-text)" }}>{myNickname || session?.user?.name || "your account"}</strong>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", padding: "0.5rem 0.25rem", alignItems: "center" }}>
                  <input
                    id="input-my-nickname"
                    type="text"
                    value={nickDraft}
                    onChange={(e) => setNickDraft(e.target.value)}
                    placeholder="Nickname"
                    className="input-field"
                    style={{ flex: 1, minWidth: 0, marginBottom: 0, padding: "0.5rem" }}
                  />
                  <button id="btn-save-my-nickname" onClick={saveMyNickname} className="primary-btn" style={{ width: "auto", padding: "0.5rem 0.75rem", fontSize: "0.8rem" }}>Save</button>
                </div>
                <button id="btn-liked-songs" ref={el => { stepRefs.current[8] = el; }} onClick={() => { setUserMenuOpen(false); setShowLikes(true); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "8px", fontSize: "0.95rem", color: "var(--color-text)", background: "transparent", border: "none", cursor: "pointer", position: tourStep === 8 ? "relative" : "static", zIndex: tourStep === 8 ? 1000 : 1 }}>Liked Songs</button>
                {/* Only rendered when the grant exists. Without it the entry is
                    absent from the DOM entirely — a hidden control rather than a
                    disabled one, so the feature is unknown to other listeners.
                    /api/skills enforces the same rule server-side. */}
                {(session.user as any)?.canUseSkills && (
                  <button id="btn-skills" onClick={() => { setUserMenuOpen(false); setShowSkills(true); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "8px", fontSize: "0.95rem", color: "var(--color-text)", background: "transparent", border: "none", cursor: "pointer" }}>Skills</button>
                )}
                <button
                  id="btn-menu-hide-name"
                  role="switch"
                  aria-checked={menuHideName}
                  onClick={toggleMenuHideName}
                  style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.6rem 0.75rem", borderRadius: "8px", fontSize: "0.9rem", color: "var(--color-text)", background: "transparent", border: "none", cursor: "pointer" }}
                >
                  <span>Hide name on likes</span>
                  <span style={{
                    flexShrink: 0, width: "40px", height: "23px", borderRadius: "999px",
                    backgroundColor: menuHideName ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                    position: "relative", transition: "background-color 0.2s ease",
                  }}>
                    <span style={{
                      position: "absolute", top: "2px", left: menuHideName ? "19px" : "2px", width: "19px", height: "19px",
                      borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                    }} />
                  </span>
                </button>
                {(session.user as any)?.isAdmin && (
                  <a id="btn-admin" href="/admin" style={{ display: "block", padding: "0.6rem 0.75rem", borderRadius: "8px", fontSize: "0.95rem", color: "var(--color-text)" }}>Admin</a>
                )}
                <button id="btn-signout" onClick={() => signOut({ callbackUrl: "/" })} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "8px", fontSize: "0.95rem", color: "var(--color-text)", background: "transparent", border: "none", cursor: "pointer" }}>Sign out</button>
              </div>
            </>
          )}
        </div>
      </header>

      {maintMode && !(session?.user as any)?.isAdmin ? (
        <div id="maintenance-notice" className="card" style={{ textAlign: "center", padding: "3rem 2rem" }}>
          <h2 id="maintenance-notice-header" style={{ marginBottom: "1rem" }}>Station under maintenance</h2>
          <p id="maintenance-notice-text" style={{ color: "var(--color-muted)", fontSize: "1rem" }}>
            {maintMsg || "Down for maintenance — back soon."}
          </p>
        </div>
      ) : (
      <>
      {backendDown && (
        <div id="backend-down-notice" className="card" style={{ textAlign: "center", padding: "1.5rem 2rem", marginBottom: "1rem" }}>
          <h2 id="backend-down-header" style={{ marginBottom: "0.5rem" }}>Station isn't available right now</h2>
          <p id="backend-down-text" style={{ color: "var(--color-muted)", fontSize: "0.95rem", margin: 0 }}>
            Lost contact with the station — check back soon. Trying again…
          </p>
        </div>
      )}
      <div id="player-grid-container" className="player-grid" aria-disabled={backendDown} style={backendDown ? { opacity: 0.4, filter: "grayscale(1)", pointerEvents: "none" } : undefined}>
        {/* Left Column */}
        <div id="player-left-column" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div id="section-now-playing" className="card" style={{ position: "static" }}>
            <div id="now-playing-art-frame" style={{ position: "relative" }}>
              <div id="now-playing-art-container" className="album-art-container" style={{ viewTransitionName: 'now-playing-art-container', position: "relative" } as any}>
              {stationData?.nowPlaying?.subsonic_id ? (
                <img
                  id="now-playing-art"
                  key={stationData.nowPlaying.subsonic_id}
                  src={`${STATION_API}/api/cover/${stationData.nowPlaying.subsonic_id}`}
                  alt="Cover"
                  className="album-art"
                  style={{ viewTransitionName: 'now-playing-art', filter: (!isPlaying && !isLoading) ? "grayscale(1)" : "none", transition: "filter 0.4s ease" } as any}
                />
              ) : (
                <div id="now-playing-art-fallback" style={{width:"100%", height:"100%", background:"#1a3050", borderRadius: "var(--radius)", viewTransitionName: 'now-playing-art', filter: (!isPlaying && !isLoading) ? "grayscale(1)" : "none", transition: "filter 0.4s ease"} as any} />
              )}
              {trackExplicit && (
                <div id="explicit-badge" title="Explicit lyrics" aria-label="Explicit lyrics" style={{ position: "absolute", left: "10px", bottom: "10px", background: "rgba(0,0,0,0.85)", border: "1px solid rgba(255,255,255,0.85)", borderRadius: "4px", padding: "2px 6px", fontSize: "10px", fontWeight: 800, letterSpacing: "0.08em", color: "#fff", pointerEvents: "none" }}>
                  EXPLICIT
                </div>
              )}
              <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", borderRadius: "var(--radius)", opacity: isPlaying ? 1 : 0, transition: "opacity 0.6s ease", pointerEvents: "none" }}>
                {[104, 116, 128, 140].map((pct, i) => (
                  <span
                    key={pct}
                    className="cx-ring"
                    style={{
                      width: `${pct}%`,
                      aspectRatio: "1 / 1",
                      ["--cx-peak" as any]: 0.30 - i * 0.05,
                      animationDelay: `${i * 0.45}s`,
                    }}
                  />
                ))}
              </div>
              {isPlaying && <span aria-hidden="true" className="cx-scan" />}
              <span aria-hidden="true" className="cx-tick cx-tick-tl" />
              <span aria-hidden="true" className="cx-tick cx-tick-tr" />
              <span aria-hidden="true" className="cx-tick cx-tick-bl" />
              <span aria-hidden="true" className="cx-tick cx-tick-br" />
              {(() => {
                const showArtToggle = isLoading || isBuffering || !isPlaying || (canHoverArt && artHover);
                return (
                  <button
                    id="btn-art-toggle"
                    onClick={togglePlay}
                    onMouseEnter={() => setArtHover(true)}
                    onMouseLeave={() => setArtHover(false)}
                    aria-label={isPlaying ? "Stop radio" : "Play radio"}
                    style={{
                      position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      background: "rgba(6,16,30,0.45)", border: "none", borderRadius: "var(--radius)", cursor: "pointer",
                      opacity: showArtToggle ? 1 : 0, transition: "opacity 0.2s ease",
                      pointerEvents: showArtToggle ? "auto" : "none",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "84px", height: "84px", borderRadius: "50%", background: "rgba(6,16,30,0.7)", border: "1px solid rgba(255,255,255,0.3)" }}>
                      {(isLoading || isBuffering) ? (
                        <div className="spinner" style={{ width: "2rem", height: "2rem" }} />
                      ) : isPlaying ? (
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#fff" }}><path d="M6 6h12v12H6z" /></svg>
                      ) : (
                        <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#fff" }}><path d="M8 5v14l11-7z" /></svg>
                      )}
                    </span>
                  </button>
                );
              })()}
            </div>
            </div>
            
            <div id="now-playing-info" ref={el => { stepRefs.current[2] = el; }} style={{ position: tourStep === 2 ? "relative" : "static", zIndex: tourStep === 2 ? 1000 : 1 }}>
              <h2 id="now-playing-title" className="track-title" style={{ viewTransitionName: 'now-playing-title', width: 'fit-content' } as any}>{stationData?.nowPlaying?.title || "Ready to Broadcast"}</h2>
              <div id="now-playing-artist" className="track-artist" style={{ viewTransitionName: 'now-playing-artist', width: 'fit-content' } as any}>
                {stationData?.nowPlaying?.artist || `${stationName} Live`}
                {stationData?.nowPlaying?.album ? <span id="now-playing-album" style={{ opacity: 0.85 }}> &middot; {stationData.nowPlaying.album}</span> : null}
                {stationData?.nowPlaying?.year ? <span style={{ opacity: 0.7 }}> &bull; {stationData.nowPlaying.year}</span> : null}
              </div>
              
              {/* No countdown when nothing is playing locally — the backend
                  always reports a live-edge track, which would read as live. */}
              {isPlaying && (
              <SongCountdown 
                nowPlaying={stationData?.nowPlaying} 
                bufferSeconds={streamBufferSec()}
                duration={trackDuration}
              />
              )}
              
              {stationData?.nowPlaying?.title && (
                <div id="now-playing-actions" ref={el => { stepRefs.current[3] = el; }} style={{ display: "flex", gap: "1rem", marginTop: "1rem", alignItems: "center", flexWrap: "wrap", viewTransitionName: 'now-playing-links', position: tourStep === 3 ? "relative" : "static", zIndex: tourStep === 3 ? 1000 : 1 } as any}>
                <div id="now-playing-links-container" style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  <a 
                    id="now-playing-link-spotify"
                    href={directLinks.spotify || `https://open.spotify.com/search/${encodeURIComponent(`track:"${stationData.nowPlaying.title}" artist:"${stationData.nowPlaying.artist}"${stationData.nowPlaying.album ? ` album:"${stationData.nowPlaying.album}"` : ''}${stationData.nowPlaying.year ? ` year:${stationData.nowPlaying.year}` : ''}`)}`}
                    target="_blank" 
                    rel="noreferrer"
                    className="music-link"
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#1DB954", fontSize: "0.9rem", fontWeight: 600, transition: "color 0.2s" }}
                  >
                    <SpotifyIcon /> Spotify
                  </a>
                  <a 
                    id="now-playing-link-apple"
                    href={directLinks.apple || `https://music.apple.com/search?term=${encodeURIComponent(`${stationData.nowPlaying.title} ${stationData.nowPlaying.artist}${stationData.nowPlaying.album ? ` ${stationData.nowPlaying.album}` : ''}`)}`}
                    target="_blank" 
                    rel="noreferrer"
                    className="music-link"
                    style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#FA243C", fontSize: "0.9rem", fontWeight: 600, transition: "color 0.2s" }}
                  >
                    <AppleMusicIcon /> Apple Music
                  </a>
                </div>
                <LikeButton trackId={stationData?.nowPlaying?.subsonic_id || (stationData?.nowPlaying ? `${stationData.nowPlaying.artist} - ${stationData.nowPlaying.title}` : "")} currentUserId={(session.user as any)?.id} title={stationData?.nowPlaying?.title} artist={stationData?.nowPlaying?.artist} album={stationData?.nowPlaying?.album} />
                </div>
              )}
            </div>
          </div>

          {hasVisibleNextShow && (
            <div id="section-up-next" className="card" ref={el => { stepRefs.current[4] = el; }} style={{ position: tourStep === 4 ? "relative" : "static", zIndex: tourStep === 4 ? 1000 : 1 }}>
              <h3 id="up-next-header" style={{ fontSize: "1.2rem", marginBottom: "0.5rem" }}>Up Next</h3>
              {getNextSong() ? (
                <div id="up-next-item-container" style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  {getNextSong().subsonic_id ? (
                    <img 
                      id="up-next-art"
                      key={getNextSong().subsonic_id}
                      src={`${STATION_API}/api/cover/${getNextSong().subsonic_id}`} 
                      alt="Cover Art" 
                      style={{ viewTransitionName: 'up-next-art', width: "60px", height: "60px", objectFit: "cover", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.5)" } as any} 
                    />
                  ) : (
                    <div id="up-next-art-fallback" style={{ viewTransitionName: 'up-next-art', width: "60px", height: "60px", background: "var(--color-surface)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" } as any}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                    </div>
                  )}
                  <div id="up-next-info" style={{ flex: 1, minWidth: 0 }}>
                    {/* maxWidth alongside fit-content is load-bearing. fit-content resolves to
                      max-content, so on its own it grew the box to the full width of the
                      title and the overflow/ellipsis below had nothing to clip — a long
                      track name ran straight out of the card. The cap keeps the hug for a
                      short title and lets the ellipsis do its job on a long one. */}
                    <div id="up-next-title" style={{ viewTransitionName: 'up-next-title', width: 'fit-content', maxWidth: '100%',fontSize: "1.05rem", fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as any}>
                      {getNextSong().title}
                    </div>
                    <div id="up-next-artist" style={{ viewTransitionName: 'up-next-artist', width: 'fit-content', maxWidth: '100%',fontSize: "0.85rem", color: "var(--color-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "0.15rem" } as any}>
                      <span style={{ color: "var(--color-text)" }}>{getNextSong().artist}</span>
                      {getNextSong().album && <span> &middot; {getNextSong().album}</span>}
                      {getNextSong().year && <span> &middot; {getNextSong().year}</span>}
                    </div>
                  </div>
                </div>
              ) : (
                <div id="up-next-autodj-fallback" className="meta-row" style={{ marginBottom: 0 }}>
                  Auto DJ
                </div>
              )}
            </div>
          )}
          
          <div id="section-on-the-air" className="card" ref={el => { stepRefs.current[5] = el; }} style={{ position: tourStep === 5 ? "relative" : "static", zIndex: tourStep === 5 ? 1000 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.5rem" }}>
              <h3 id="on-the-air-header" style={{ fontSize: "1.2rem", margin: 0 }}>On The Air</h3>
              {(showName || onAirName) && (
                <div id="on-the-air-show-info" style={{ fontSize: "0.9rem", color: "var(--color-ink)", fontWeight: 500, background: "rgba(0,0,0,0.2)", padding: "4px 8px", borderRadius: "6px" }}>
                  {showName && <span>{showName}</span>}
                  {showName && onAirName && <span style={{ margin: "0 4px", color: "var(--color-muted)" }}>•</span>}
                  {onAirName && <span style={{ color: "#ff4d4d" }}>with {onAirName}</span>}
                </div>
              )}
            </div>
            
            {renderAvatars()}

            {showRunway && (
              <div id="on-air-ends" style={{ marginTop: "1rem", color: "var(--color-text)", fontSize: "0.9rem", fontWeight: 600, background: "rgba(255,255,255,0.05)", padding: "8px 12px", borderRadius: "6px" }}>
                On air until {fmtClock(showRunway.endMs, showRunway.tz)} · {fmtDurLeft(showRunway.leftMin)}
              </div>
            )}
            {showRunway?.nextName && (
              <div id="on-air-next-up" style={{ marginTop: "0.5rem", color: "var(--color-muted)", fontSize: "0.9rem", background: "rgba(255,255,255,0.05)", padding: "8px 12px", borderRadius: "6px" }}>
                Next: <span style={{ color: "var(--color-text)", fontWeight: 600 }}>{showRunway.nextName}</span>
                {showRunway.nextHost && <span> with <span style={{ color: "#ff4d4d" }}>{showRunway.nextHost}</span></span>}
                <span> at {fmtClock(showRunway.endMs, showRunway.tz)}</span>
              </div>
            )}
            
            {nextShowText && (
              <div id="on-the-air-next-show" style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "0.85rem", fontStyle: "italic", background: "rgba(255,255,255,0.05)", padding: "8px 12px", borderRadius: "6px" }}>
                {nextShowText}
              </div>
            )}
            
            {/* Upcoming Songs */}
            {stationData?.upcoming && stationData.upcoming.length > 0 && (
              <div id="next-playing-song" style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <h4 id="next-playing-header" style={{ fontSize: "0.9rem", color: "var(--color-muted)", margin: "0 0 0.5rem 0", textTransform: "uppercase", letterSpacing: "1px" }}>Coming Up Next</h4>
                {stationData.upcoming.slice(0, 2).map((track: any, i: number) => (
                  <div id={`next-playing-item-${i}`} key={track.subsonic_id || i} style={{ padding: "0.75rem", background: "rgba(0,0,0,0.2)", borderRadius: "var(--radius)", display: "flex", gap: "1rem", alignItems: "center" }}>
                    {track.subsonic_id ? (
                      <img 
                        id={`next-playing-art-${i}`}
                        src={`${STATION_API}/api/cover/${track.subsonic_id}`} 
                        alt="Cover Art" 
                        style={{ viewTransitionName: `coming-up-art-${i}`, width: "60px", height: "60px", objectFit: "cover", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.5)" } as any} 
                      />
                    ) : (
                      <div id={`next-playing-art-fallback-${i}`} style={{ viewTransitionName: `coming-up-art-${i}`, width: "60px", height: "60px", background: "var(--color-surface)", borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center" } as any}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
                      </div>
                    )}
                    <div id={`next-playing-info-${i}`} style={{ flex: 1, minWidth: 0 }}>
                      <div id={`next-playing-title-${i}`} style={{ viewTransitionName: `coming-up-title-${i}`, width: 'fit-content', maxWidth: '100%',fontSize: "1rem", fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as any}>
                        {track.title}
                      </div>
                      <div id={`next-playing-artist-${i}`} style={{ viewTransitionName: `coming-up-artist-${i}`, width: 'fit-content', maxWidth: '100%',fontSize: "0.85rem", color: "var(--color-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: "0.25rem" } as any}>
                        <span style={{ color: "var(--color-text)" }}>{track.artist}</span>
                        {track.album && <span> &middot; {track.album}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div id="player-right-column" className="controls-card">
          <div id="section-player-controls" className="card" style={{ position: "static", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <button id="btn-play-radio" ref={el => { stepRefs.current[1] = el; }} className={`play-btn ${isPlaying || isLoading ? "playing" : ""}`} onClick={togglePlay} style={{ position: tourStep === 1 ? "relative" : "static", zIndex: tourStep === 1 ? 1000 : 1 }}>
              <div id="btn-play-text-container" key={isLoading ? "starting" : isBuffering ? "reconnecting" : isPlaying ? "stop" : "play"} className="fade-swap" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
                {isLoading ? (
                  <>
                    <div className="spinner" />
                    Starting station…
                  </>
                ) : isBuffering ? (
                  <>
                    <div className="spinner" />
                    Reconnecting…
                  </>
                ) : isPlaying ? (
                  <>
                    <StopIcon /> Stop Radio
                  </>
                ) : (
                  <>
                    <PlayIcon /> Play Radio
                  </>
                )}
              </div>
            </button>
            {isAsleepWakeup && (
              <div id="player-asleep-text" style={{ color: "var(--color-accent)", fontSize: "0.95rem", textAlign: "center", fontWeight: 600 }}>
                The radio is asleep! It will take 30-60 seconds to wake up and come online. Please wait...
              </div>
            )}

            {(() => {
              const isAdmin = !!(session?.user as any)?.isAdmin;
              // Non-admins need audio running to skip/block. Admins operate the
              // booth from a stopped player too, so the gate never applies to
              // them — the station can be on air with nobody local listening.
              if (!isPlaying && !isLoading && !isAdmin) return null;
              const listeners = stationData?.listeners?.current;
              const solo = typeof listeners === "number" && listeners <= 1;
              // Admin always gets Skip. For a listener this is the operator's
              // setting — hidden / solo / always (lib/skipvisibility.ts). Same
              // helper the skip route enforces with, so the button is never a
              // dead control.
              const showSkip = isAdmin || canSkipAsListener(skipVisibility, listeners);
              const showNever = isAdmin && !!stationData?.nowPlaying?.subsonic_id;
              if (!showSkip && !showNever) return null;
              const cooling = skipCooldownLeft > 0;
              const skipEnabled = !cooling && !skipLocked && adminBusy === null;
              const skipLabel = adminBusy === "skip"
                ? "Skipping…"
                : skipLocked
                  ? "Next song incoming"
                  : cooling
                    ? `Skip in ${skipCooldownLeft}s`
                    : "Skip track";
              const skipTitle = skipLocked
                ? `The next song is already buffered — ${trackRemaining}s left on this one`
                : "Skip track";
              return (
                <div id="admin-track-controls" style={{ display: "flex", gap: "0.75rem", alignItems: "stretch", flexWrap: "wrap" }}>
                  {showSkip && (
                  <button
                    id="btn-skip-track"
                    onClick={adminSkipTrack}
                    disabled={!skipEnabled}
                    title={skipTitle}
                    style={{ flex: "1 1 160px", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", backgroundColor: "rgba(239,68,68,0.10)", color: "#f2f2f2", border: "1px solid rgba(239,68,68,0.55)", padding: "0.85rem 1rem", borderRadius: "999px", fontSize: "0.95rem", fontWeight: 600, opacity: skipEnabled ? 1 : 0.45, cursor: skipEnabled ? "pointer" : "default", textAlign: "center" }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l9.997 5.998a2 2 0 0 1 .003 3.458l-10 6A2 2 0 0 1 5 17z" /><line x1="19" y1="5" x2="19" y2="19" strokeWidth="2.5" /></svg>
                    {skipLabel}
                  </button>
                  )}
                  {showNever && (
                    <div style={{ position: "relative", flex: "1 1 160px", minWidth: 0, display: "flex" }}>
                      <button
                        id="btn-never-play"
                        onClick={() => setBlockMenuOpen(o => !o)}
                        disabled={adminBusy !== null}
                        aria-expanded={blockMenuOpen}
                        aria-haspopup="true"
                        title="Never play this on air"
                        style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", backgroundColor: "rgba(255,255,255,0.06)", color: "var(--color-text)", border: "1px solid rgba(255,255,255,0.16)", padding: "0.85rem 1rem", borderRadius: "999px", fontSize: "0.95rem", fontWeight: 600, opacity: adminBusy !== null ? 0.5 : 1, cursor: adminBusy !== null ? "default" : "pointer", textAlign: "center" }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M4.929 4.929 19.07 19.071" /></svg>
                        {adminBusy === "block" ? "Blocking…" : "Never play"}
                      </button>
                      {blockMenuOpen && (
                        <div id="never-play-menu" style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 50, minWidth: "220px", backgroundColor: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: "8px", padding: "0.25rem", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                          <button id="btn-never-play-track" onClick={() => adminBlockTrack("track")} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "6px", fontSize: "0.9rem", color: "var(--color-text)" }}>
                            Never play this track
                          </button>
                          {stationData.nowPlaying.album && (
                            <button id="btn-never-play-album" onClick={() => adminBlockTrack("album")} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "6px", fontSize: "0.9rem", color: "var(--color-text)" }}>
                              Never play this album
                            </button>
                          )}
                          {stationData.nowPlaying.artist && (
                            <button id="btn-never-play-artist" onClick={() => adminBlockTrack("artist")} style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem 0.75rem", borderRadius: "6px", fontSize: "0.9rem", color: "var(--color-text)" }}>
                              Never play this artist
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
            {adminAck && <div id="admin-track-ack" className={adminAckShow ? "admin-ack show" : "admin-ack"}>{adminAck}</div>}
            
            {donateEnabled && donateUrl ? (
            <a id="btn-support" href={donateUrl} target="_blank" rel="noreferrer" className="donate-btn" style={{ padding: "1.5rem", fontSize: "1.2rem", width: "100%", textAlign: "center", display: "block" }}>
              {donateText}
            </a>
            ) : null}
          </div>

          <div id="section-request-song" className="card" style={{ position: "static" }}>
            <h3 id="request-song-header" style={{ marginBottom: "1rem" }}>Request Something</h3>
            <textarea 
              id="input-request-song"
              ref={el => { stepRefs.current[6] = el; }}
              className="input-field" 
              placeholder={phText || " "}
              value={reqSong}
              onChange={e => setReqSong(e.target.value)}
              rows={3}
              style={{ resize: "vertical", fontFamily: "inherit", position: tourStep === 6 ? "relative" : "static", zIndex: tourStep === 6 ? 1000 : 1 }}
            />
            <input 
              id="input-request-name"
              type="text" 
              className="input-field" 
              placeholder={phNameText || " "} 
              value={reqName}
              onChange={e => setReqName(e.target.value)}
            />
            {/* Locked for the whole of posting AND waiting: the button stays dead
                until the booth has actually answered or we have given up on it,
                which is what the dots beside the label are saying. */}
            <button
              id="btn-submit-request"
              className="submit-btn"
              onClick={submitRequest}
              disabled={!reqSong || reqStage !== "idle" || reqCooldownLeft > 0}
            >
              {reqStage === "posting"
                ? "Sending your request"
                : reqStage === "waiting"
                  ? `Checking with the DJ · ${reqWaitSecs}s`
                  : reqCooldownLeft > 0
                    ? `Send again in ${reqCooldownLeft}s`
                    : "Send to the booth"}
              {reqStage === "posting" ? <LoadingDots label="Sending your request" /> : null}
              {reqStage === "waiting" ? <LoadingDots label="Waiting for the DJ" /> : null}
              {reqStage === "idle" && reqCooldownLeft === 0 ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 7h10v10"></path>
                  <path d="M7 17 17 7"></path>
                </svg>
              ) : null}
            </button>
            {reqAck && (
              <div
                id="request-ack-text"
                role="status"
                aria-live="polite"
                style={{
                  marginTop: "1rem",
                  // Red only for the states that are actually a problem, so the
                  // escalating "still nothing" line does not read as an error.
                  color: reqStage === "idle" && /wrong|lost|stopped waiting/i.test(reqAck)
                    ? "#e06a5c"
                    : "var(--color-accent)",
                  fontSize: "0.875rem",
                }}
              >
                {reqAck}
              </div>
            )}

          </div>

          {(session?.user as any)?.canUseDj && (
            <div id="section-dj-say" className="card" style={{ position: "static" }}>
              <h3 id="dj-say-header" style={{ marginBottom: "1rem" }}>Manual Voice DJ</h3>
              <textarea
                id="input-say-text"
                className="input-field"
                placeholder={sayMode === "raw" ? "Exact words the DJ will speak, verbatim…" : "Instruction or topic. DJ writes it in persona…"}
                value={sayText}
                onChange={e => setSayText(e.target.value)}
                maxLength={500}
                rows={3}
                style={{ resize: "vertical", fontFamily: "inherit" }}
              />
              <div id="say-controls" style={{ display: "flex", gap: "1.5rem", marginTop: "0.75rem", marginBottom: "1rem", flexWrap: "wrap" }}>
                <div id="say-mode-group" role="radiogroup" aria-label="Mode" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span className="seg-caption">mode</span>
                  <div className="seg-group">
                    <button id="radio-say-raw" className="seg-btn" onClick={() => setSayMode("raw")} aria-pressed={sayMode === "raw"}>Raw</button>
                    <button id="radio-say-styled" className="seg-btn" onClick={() => setSayMode("styled")} aria-pressed={sayMode === "styled"}>Styled</button>
                  </div>
                </div>
                <div id="say-duck-group" role="radiogroup" aria-label="Duck" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span className="seg-caption">duck</span>
                  <div className="seg-group">
                    <button id="radio-say-solo" className="seg-btn" onClick={() => setSayKind("dj-speak")} aria-pressed={sayKind === "dj-speak"}>Solo</button>
                    <button id="radio-say-over" className="seg-btn" onClick={() => setSayKind("link")} aria-pressed={sayKind === "link"}>Over</button>
                  </div>
                </div>
              </div>
              <button
                id="btn-send-say"
                className="submit-btn"
                onClick={submitSay}
                disabled={!sayText.trim() || sayBusy}
              >
                {sayBusy ? "Sending..." : "Send to air →"}
              </button>
              {sayAck && <div id="say-status-msg" className={sayAckShow ? "flash-ack show" : "flash-ack"} style={{ marginTop: "1rem" }}>{sayAck}</div>}
            </div>
          )}
        </div>
      </div>
      </>
      )}

      {reconnecting && (
        <div id="reconnect-pill" role="status" style={{ position: "fixed", bottom: "2rem", left: "50%", transform: "translateX(-50%)", zIndex: 1500, display: "flex", alignItems: "center", gap: "0.5rem", background: "rgba(6,16,30,0.9)", border: "1px solid var(--color-border)", borderRadius: "999px", padding: "0.6rem 1.1rem", fontSize: "0.85rem", color: "var(--color-text)", pointerEvents: "none" }}>
          <span className="spinner" style={{ width: "1rem", height: "1rem", borderWidth: "2px" }} />
          Reconnecting…
        </div>
      )}

      <button id="btn-help-tour" title="Replay the guided tour" aria-label="Replay the guided tour" className="help-btn" onClick={() => setTourStep(0)}>
        <span style={{ fontSize: "26px", fontWeight: 800, lineHeight: 1 }} aria-hidden="true">?</span>
      </button>

      {/* Welcome Tour Overlay */}
      {tourStep >= 0 && <div id="tour-overlay-bg" className="tour-overlay-bg" />}
      {tourStep >= 0 && tourSpot && (
        <div
          id="tour-spotlight"
          aria-hidden="true"
          style={{
            position: "fixed",
            top: `${tourSpot.top}px`,
            left: `${tourSpot.left}px`,
            width: `${tourSpot.width}px`,
            height: `${tourSpot.height}px`,
            border: "2px solid var(--color-accent)",
            borderRadius: "14px",
            boxShadow: "0 0 28px 4px rgba(78,159,212,0.55)",
            transition: "top 0.3s ease, left 0.3s ease, width 0.3s ease, height 0.3s ease, opacity 0.25s ease",
            opacity: 1,
            zIndex: 995,
            pointerEvents: "none",
          }}
        />
      )}
      
      <div 
        id="tour-card"
        className="tour-card" 
        style={{
          ...tooltipStyle,
          pointerEvents: tourStep >= 0 ? 'auto' : 'none',
        }}
      >
        <div id="tour-text" key={tourStep} className="tour-text fade-swap">
          {tourStep === 0 && `Welcome to ${stationName}! This quick guide will show you how to listen to the radio.`}
          {tourStep === 1 && "Tap the big Play button to start the radio stream."}
          {tourStep === 2 && "This shows you what song is playing right now."}
          {tourStep === 3 && "Open a song in Spotify or Apple Music here — or tap the heart to save it to your Liked Songs."}
          {tourStep === 4 && "And this tells you what's coming up next."}
          {tourStep === 5 && "This is the DJ currently running the station!"}
          {tourStep === 6 && "Request songs or shout-outs here."}
          {tourStep === 7 && "Your account lives behind this button — liked songs, nickname, admin, sign out."}
          {tourStep === 8 && "Everything you heart lives under Liked Songs — with Spotify and Apple Music links for each one."}
          {tourStep === 9 && "That's it — enjoy the music! You can tap the ? button at any time if you need a reminder."}
        </div>
        <button id="btn-tour-next" className="tour-next-btn" onClick={advanceTour}>
          {tourStep === 9 ? "Finish" : "Next →"}
        </button>
        <button id="btn-tour-skip" className="tour-skip" onClick={() => { setTourStep(-1); localStorage.setItem("hasSeenTour", "true"); }}>
          Skip Tour
        </button>
      </div>
      <audio id="radio-player" ref={audioRef} preload="none" />

      {showLikes && (
        <div id="likes-overlay-bg" onClick={() => setShowLikes(false)} className="overlay-bg-enter" style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.7)", zIndex: 2000, overflowY: "auto", padding: "2rem 1rem" }}>
          <div id="likes-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "720px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Liked Songs</h2>
                <button id="btn-close-likes" onClick={() => setShowLikes(false)} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
              </div>
              <LikedSongsPanel />
            </div>
          </div>
        </div>
      )}
      {showHost && (
        <div id="host-overlay-bg" onClick={() => setShowHost(null)} className="overlay-bg-enter" style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.7)", zIndex: 2000, overflowY: "auto", padding: "2rem 1rem" }}>
          <div id="host-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "480px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h2 style={{ fontSize: "1.3rem", margin: 0 }}>{showHost.name}</h2>
                <button id="btn-close-host" onClick={() => setShowHost(null)} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
              </div>
              <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
                {showHost.avatar ? (
                  <img id="host-profile-img" src={showHost.avatar} alt={showHost.name} style={{ width: "160px", height: "160px", borderRadius: "12px", objectFit: "cover", flexShrink: 0 }} />
                ) : null}
                <div>
                  <div id="host-profile-role" style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>{showHost.role}{showName ? ` on ${showName}` : ""}</div>
                  {showHost.tagline ? (
                    <p id="host-profile-tagline" style={{ marginTop: "0.5rem", marginBottom: 0 }}>{showHost.tagline}</p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {showSkills && (
        <div id="skills-overlay-bg" onClick={() => setShowSkills(false)} className="overlay-bg-enter" style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.7)", zIndex: 2000, overflowY: "auto", padding: "2rem 1rem" }}>
          <div id="skills-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "720px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
            <div className="card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Skills</h2>
                <button id="btn-close-skills" onClick={() => setShowSkills(false)} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
              </div>
              <SkillsPanel />
            </div>
          </div>
        </div>
      )}

      {/* Version, and where updates come from.
          The number is the same string package.json carries and the release is
          tagged with (lib/version.ts), so it cannot drift from either — an operator
          reading this knows exactly what is running. The link is what makes a
          release useful: it is where the notes and the upgrade instructions are. */}
      <footer id="app-footer" style={{ marginTop: "3rem", display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.8rem", color: "var(--color-text-dim)", background: "rgba(0,0,0,0.45)", borderRadius: "999px", padding: "0.4rem 1rem", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
        <a
          id="footer-version"
          href={`${REPO_URL}/releases`}
          target="_blank"
          rel="noreferrer"
          title={`${APP_NAME} ${APP_VERSION} — check for updates`}
          style={{ color: "inherit", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.5)", paddingBottom: "1px" }}
        >
          {APP_NAME} {APP_VERSION}
        </a>
        <span aria-hidden="true">&middot;</span>
        <span>
          unofficial companion to{" "}
          <a
            href={SUBWAVE_URL}
            target="_blank"
            rel="noreferrer"
            title="Subwave — the upstream project (not affiliated)"
            style={{ color: "inherit", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.5)", paddingBottom: "1px" }}
          >
            Subwave
          </a>
        </span>
        <span aria-hidden="true">&middot;</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          title={`${APP_NAME} source on GitHub`}
          style={{ color: "inherit", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.5)", paddingBottom: "1px" }}
        >
          source
        </a>
        </div>
      </footer>

    </main>
  );
}
