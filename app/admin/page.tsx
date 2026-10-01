"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STATION } from "@/lib/station";
import DatabasePanel from "./DatabasePanel";
import CollapsibleSection from "./CollapsibleSection";
import {
  SKIP_VISIBILITY_OPTIONS,
  parseSkipVisibility,
  type SkipVisibility,
} from "@/lib/skipvisibility";

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [users, setUsers] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [signedInUsers, setSignedInUsers] = useState<any[]>([]);
  const [streamingUsers, setStreamingUsers] = useState<any[]>([]);
  const loadPresence = () => {
    fetch("/api/presence")
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.users)) setSignedInUsers(d.users);
        if (Array.isArray(d.streaming)) setStreamingUsers(d.streaming);
      })
      .catch(() => {});
  };
  const [nickDrafts, setNickDrafts] = useState<Record<string, string>>({});
  // Where each settings field's value came from (db = saved here, env =
  // server file). Blank DB fields prefill from env so set values never look missing.
  const [envSrc, setEnvSrc] = useState<Record<string, string>>({});
  const envTag = (k: string) => envSrc[k] === "env" ? (
    <span style={{ fontWeight: 400, fontSize: "0.8rem", color: "var(--color-muted)" }}> · server env</span>
  ) : null;
  const [donations, setDonations] = useState<any[]>([]);
  // Whether the donations fetch has landed. The panel hides itself when there is
  // nothing to read, and donations.length is 0 until the response arrives — so
  // without this it would flash away and back on every page load.
  const [donationsLoaded, setDonationsLoaded] = useState(false);
  const [donateUrl, setDonateUrl] = useState(STATION.donateUrl);
  const [donateText, setDonateText] = useState("Send a tip to keep the station alive ☕");
  const [donateOn, setDonateOn] = useState(true);
  const [maintOn, setMaintOn] = useState(false);
  const [maintText, setMaintText] = useState("");
  const [maintMsg, setMaintMsg] = useState("");
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintPreview, setMaintPreview] = useState(false);
  const [verboseOn, setVerboseOn] = useState(true);
  const [verboseMsg, setVerboseMsg] = useState("");
  const [verboseBusy, setVerboseBusy] = useState(false);
  const [stationPassword, setStationPassword] = useState("");
  const [subwaveApiUrl, setSubwaveApiUrl] = useState("");
  const [subwaveAdminUser, setSubwaveAdminUser] = useState("");
  const [subwaveAdminPass, setSubwaveAdminPass] = useState("");
  const [serverMsg, setServerMsg] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [streamMode, setStreamMode] = useState<"relay" | "direct">("relay");
    // Who listeners get the Skip button. Admins always see it regardless.
    const [skipVisibility, setSkipVisibility] = useState<SkipVisibility>("solo");
  const [backendListeners, setBackendListeners] = useState<number | null>(null);
  const [backendBuffer, setBackendBuffer] = useState<number | null>(null);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [pushDevices, setPushDevices] = useState(0);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [vapidPublic, setVapidPublic] = useState("");
  const [vapidPrivate, setVapidPrivate] = useState("");
  const [vapidSubject, setVapidSubject] = useState("");
  const [vapidBusy, setVapidBusy] = useState(false);
  const [bmacSecret, setBmacSecret] = useState("");
  const [spotifyId, setSpotifyId] = useState("");
  const [explicitSuffixOn, setExplicitSuffixOn] = useState(true);
  const [spotifySecret, setSpotifySecret] = useState("");
  const [musicMsg, setMusicMsg] = useState("");
  const [musicBusy, setMusicBusy] = useState(false);
  const [idName, setIdName] = useState("");
  const [idTagline, setIdTagline] = useState("");
  const [idDescription, setIdDescription] = useState("");
  const [idAbout, setIdAbout] = useState("");
  const [idBackendUrl, setIdBackendUrl] = useState("");
  const [idDonateUrl, setIdDonateUrl] = useState("");
  const [idNextauthUrl, setIdNextauthUrl] = useState("");
  // Whether the donation webhook will actually accept anything. The panel would
  // otherwise show a URL and leave the operator to find out the hard way.
  const [webhook, setWebhook] = useState<{
    provider: string; endpoint: string; configured: boolean; source: string | null;
  } | null>(null);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [idMsg, setIdMsg] = useState("");
  const [idBusy, setIdBusy] = useState(false);
  const [brandMsg, setBrandMsg] = useState("");
  const [brandBusy, setBrandBusy] = useState<string | null>(null);
  const [brandTab, setBrandTab] = useState<"logo" | "icon" | "background">("logo");
  const [brandVersion, setBrandVersion] = useState(0);
  // Tab rail: one screen per job. Persisted so a refresh lands back here.
  type AdminTab = "stats" | "people" | "station" | "services" | "system" | "database";
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    try {
      const t = localStorage.getItem("admin-tab");
      return t === "people" || t === "station" || t === "services" || t === "system" || t === "database" ? t : "stats";
    } catch { return "stats"; }
  });
  // "out" while the current panel fades, "in" once the new one should rise.
  const [tabPhase, setTabPhase] = useState<"in" | "out">("in");
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // How long the outgoing panel takes to fade. Must equal the CSS
  // .admin-panel.phase-out duration: if it ran longer the swap would land
  // mid-fade, and if it ran shorter the new panel would start from a
  // half-faded frame. Out 120ms + in 200ms = 320ms for the whole swap.
  const PANEL_OUT_MS = 120;

  const showTab = (t: AdminTab) => {
    if (t === activeTab) return;
    try { localStorage.setItem("admin-tab", t); } catch {}
    // With reduced motion requested the CSS animations are off, so waiting out
    // the fade-out would only add a dead 120ms pause. Swap immediately instead.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setActiveTab(t);
      return;
    }
    // Clicking through several tabs quickly must not let a stale timer swap in
    // a tab the user has already navigated past.
    if (swapTimer.current) clearTimeout(swapTimer.current);
    setTabPhase("out");
    swapTimer.current = setTimeout(() => {
      setActiveTab(t);
      setTabPhase("in");
    }, PANEL_OUT_MS);
  };

  useEffect(() => {
    // A tab swap still pending when the admin page goes away would fire a
    // setState on an unmounted component.
    return () => { if (swapTimer.current) clearTimeout(swapTimer.current); };
  }, []);
  const pendingCount = users.filter((u: any) => !u.isApproved).length;
  // Donations under Stats, hidden only when there is genuinely nothing to read:
  // support button off AND nothing ever donated. Deliberately NOT hidden merely
  // because the button is off — money arrives through the Buy Me A Coffee
  // webhook, not the button, so anyone with a bookmarked link keeps tipping
  // after it is hidden and that income has to stay visible.
  const showDonationsSection =
    activeTab === "stats" && (donateOn || !donationsLoaded || donations.length > 0);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
    if (status === "authenticated" && !(session?.user as any)?.isAdmin) {
      router.push("/");
    }

    let presenceId: ReturnType<typeof setInterval> | null = null;
    if (status === "authenticated" && (session?.user as any)?.isAdmin) {
      fetchData();
      loadPresence();
      presenceId = setInterval(loadPresence, 30000);
      fetch("/api/push/status")
        .then(r => r.json())
        .then(d => { if (typeof d.devices === "number") setPushDevices(d.devices); })
        .catch(() => {});
      fetch("/api/admin/identity/save")
        .then(r => r.json())
        .then(d => {
          if (d.name) setIdName(d.name);
          if (d.tagline) setIdTagline(d.tagline);
          if (d.description) setIdDescription(d.description);
          if (d.about) setIdAbout(d.about);
          if (d.backendUrl) setIdBackendUrl(d.backendUrl);
          if (d.donateUrl) setIdDonateUrl(d.donateUrl);
          if (d.nextauthUrl) setIdNextauthUrl(d.nextauthUrl);
          fetch("/api/admin/webhook")
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d) setWebhook(d); })
            .catch(() => {});
        })
        .catch(() => {});
    }
    return () => { if (presenceId) clearInterval(presenceId); };
  }, [status, session]);

  const fetchData = async () => {
    try {
      const [uRes, sRes, dRes, setRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/stats"),
        fetch("/api/admin/donations"),
        fetch("/api/admin/settings")
      ]);
      if (uRes.ok) setUsers(await uRes.json());
      if (sRes.ok) setStats(await sRes.json());
      if (dRes.ok) setDonations(await dRes.json());
      setDonationsLoaded(true);
      if (setRes.ok) {
        const settings = await setRes.json();
        const eff: Record<string, { value: string; source: string }> = await fetch("/api/admin/config/effective")
          .then(r => r.json()).catch(() => ({}));
        const src: Record<string, string> = {};
        const fill = (dbKey: string, set: (v: string) => void) => {
          const dbHit = settings.find((s: any) => s.key === dbKey);
          const e = eff[dbKey];
          if (dbHit) {
            set(dbHit.value);
            src[dbKey] = "db";
          } else if (e?.value) {
            set(e.value);
            src[dbKey] = "env";
          }
        };
        fill("donate_url", setDonateUrl);
        fill("donate_text", setDonateText);
        fill("stationPassword", setStationPassword);
        fill("subwaveApiUrl", setSubwaveApiUrl);
        fill("subwaveAdminUser", setSubwaveAdminUser);
        fill("subwaveAdminPass", setSubwaveAdminPass);
        fill("bmacWebhookSecret", setBmacSecret);
        fill("googleClientId", setGoogleClientId);
        fill("googleClientSecret", setGoogleClientSecret);
        fill("adminEmail", setAdminEmail);
        fill("vapidPublicKey", setVapidPublic);
        fill("vapidPrivateKey", setVapidPrivate);
        fill("vapidSubject", setVapidSubject);
        fill("spotifyClientId", setSpotifyId);
        fill("spotifyClientSecret", setSpotifySecret);
        setEnvSrc(src);
        const sm = settings.find((s: any) => s.key === "streamMode");
        if (sm) setStreamMode(sm.value === "direct" ? "direct" : "relay");
          const sv = settings.find((s: any) => s.key === "skipVisibility");
          if (sv) setSkipVisibility(parseSkipVisibility(sv.value));
        if (STATION.backendUrl) {
          fetch(`${STATION.backendUrl}/api/now-playing`)
            .then(r => r.json())
            .then(d => {
              const c = d?.listeners?.current;
              if (typeof c === "number") setBackendListeners(c);
              // Stream buffer is owned by Subwave and published on
              // /api/now-playing — read-only here, changed in Subwave's admin.
              const b = d?.stream?.bufferSeconds;
              if (typeof b === "number") setBackendBuffer(b);
            })
            .catch(() => {});
        }
        const de = settings.find((s: any) => s.key === "donate_enabled");
        if (de) setDonateOn(de.value !== "false");
        const es = settings.find((s: any) => s.key === "explicitSuffix");
        if (es) setExplicitSuffixOn(es.value !== "false");
        const mm = settings.find((s: any) => s.key === "maintenanceMode");
        if (mm) setMaintOn(mm.value === "true");
        const mt = settings.find((s: any) => s.key === "maintenanceMessage");
        if (mt) setMaintText(mt.value);
        const vl = settings.find((s: any) => s.key === "verboseLogging");
        if (vl) setVerboseOn(vl.value !== "false");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const saveSupportSettings = async () => {
    const put = (key: string, value: string) =>
      fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    await put("donate_enabled", donateOn ? "true" : "false");
    // URL + text are pointless while hidden — leave stored values alone.
    if (donateOn) {
      await put("donate_url", donateUrl);
      await put("donate_text", donateText);
    }
    await put("bmacWebhookSecret", bmacSecret);
    alert("Support button saved!");
  };

  const saveMaintenance = async () => {
    setMaintBusy(true);
    setMaintMsg("");
    try {
      const put = (key: string, value: string) =>
        fetch("/api/admin/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
      await put("maintenanceMode", maintOn ? "true" : "false");
      await put("maintenanceMessage", maintText);
      setMaintMsg(maintOn ? "Maintenance on — players see the notice." : "Maintenance off — player live.");
    } catch {
      setMaintMsg("Save failed.");
    } finally {
      setMaintBusy(false);
    }
  };
  const saveVerbose = async () => {
    setVerboseBusy(true);
    setVerboseMsg("");
    try {
      await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "verboseLogging", value: verboseOn ? "true" : "false" }),
      });
      setVerboseMsg(verboseOn ? "Verbose logging on — player consoles narrate." : "Verbose logging off — errors only.");
    } catch {
      setVerboseMsg("Save failed.");
    } finally {
      setVerboseBusy(false);
    }
  };
  const saveStreamMode = async (mode: "relay" | "direct") => {    setStreamMode(mode);
    await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "streamMode", value: mode }),
    });
  };
  // The address Buy Me A Coffee posts to: the public site origin plus the
  // endpoint. Falls back to the host the admin is actually looking at, so it is
  // never blank or wrong just because the identity field is unset.
  const bmacWebhookUrl = (() => {
    const base = (idNextauthUrl || "").trim().replace(/\/+$/, "");
    const origin = base || (typeof window !== "undefined" ? window.location.origin : "");
    return origin ? `${origin}/api/webhooks/bmac` : "";
  })();

  const copyWebhookUrl = async () => {
    if (!bmacWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(bmacWebhookUrl);
    } catch {
      // Clipboard is blocked without a user gesture or over plain http; the
      // field is selectable either way, so this is a nicety not a feature.
      return;
    }
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 1600);
  };

  const saveSkipVisibility = async (mode: SkipVisibility) => {
    setSkipVisibility(mode);
    await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "skipVisibility", value: mode }),
    });
  };
  const testServer = async () => {
    setServerBusy(true);
    setServerMsg("Contacting backend… (save first — the test reads saved values)");
    try {
      const res = await fetch("/api/admin/server/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const bits = [`On air: ${data.track}`];
        if (typeof data.listeners === "number") bits.push(`${data.listeners} listening`);
        if (Array.isArray(data.checks)) {
          for (const c of data.checks) bits.push(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
        }
        if (data.warning) bits.push(data.warning);
        setServerMsg(`Working — ${bits.join(" · ")}.`);
      } else {
        const bits = [data.error || "unknown error"];
        if (Array.isArray(data.checks)) {
          for (const c of data.checks) bits.push(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
        }
        setServerMsg(`Failed: ${bits.join(" · ")}`);
      }
    } catch {
      setServerMsg("Failed: no response.");
    } finally {
      setServerBusy(false);
    }
  };
  const saveServerSettings = async () => {
    setServerMsg("");
    const put = (key: string, value: string) =>
      fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    await put("subwaveApiUrl", subwaveApiUrl);
    await put("subwaveAdminUser", subwaveAdminUser);
    await put("subwaveAdminPass", subwaveAdminPass);
    await put("stationPassword", stationPassword);
    // Propagate: repoint the 1-to-many relay at the saved backend + password.
    setServerMsg("Settings saved — syncing relay…");
    try {
      const res = await fetch("/api/admin/server/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setServerMsg(
          data.changed
            ? `Relay repointed to ${data.server}:${data.port} — stream OK.`
            : `Relay already on ${data.server}:${data.port} — stream OK.`
        );
      } else {
        setServerMsg(`Settings saved, but relay sync failed: ${data.error || "unknown error"}`);
      }
    } catch {
      setServerMsg("Settings saved, but relay sync failed: no response.");
    }
  };

  const fmtDur = (sec: number) => {
    const s = Math.max(Math.round(sec || 0), 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  };

  const saveAuthSettings = async () => {
    setAuthMsg("Saving — the station restarts to apply sign-in changes…");
    try {
      const res = await fetch("/api/admin/auth/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ googleClientId, googleClientSecret, adminEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setAuthMsg("Saved. Station restarting — logins use the new values in a few seconds.");
      } else {
        setAuthMsg(`Save failed: ${data.error || "unknown error"}`);
      }
    } catch {
      setAuthMsg("Save failed: no response.");
    }
  };

  const testAuth = async () => {
    setAuthBusy(true);
    setAuthMsg("Checking ID shape… (save first — the test reads the fields above)");
    try {
      const res = await fetch("/api/admin/auth/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: googleClientId, clientSecret: googleClientSecret }),
      });
      const data = await res.json().catch(() => ({}));
      setAuthMsg(res.ok ? data.message : `Failed: ${data.error || "unknown error"}`);
    } catch {
      setAuthMsg("Failed: no response.");
    } finally {
      setAuthBusy(false);
    }
  };

  const saveNickname = async (userId: string) => {
    await fetch("/api/admin/users/nickname", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, nickname: nickDrafts[userId] ?? "" }),
    });
    setNickDrafts(d => {
      const c = { ...d };
      delete c[userId];
      return c;
    });
    fetchData();
  };

  const enablePush = async () => {
    setPushBusy(true);
    setPushMsg("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushMsg("Push isn't available here — open the installed homescreen app (iOS Safari tabs can't receive push).");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (Notification.permission === "denied") {
        setPushMsg("Notifications are blocked for this app — allow them in phone Settings, then try again.");
        return;
      }
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
      if (Notification.permission !== "granted") {
        setPushMsg("Permission not granted — no alerts on this device.");
        return;
      }
      const cfg = await fetch("/api/push/config").then(r => r.json());
      if (!cfg.publicKey) {
        setPushMsg("Server push keys missing — contact setup.");
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: cfg.publicKey,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.toJSON().keys }),
      });
      if (!res.ok) {
        setPushMsg("Server refused the subscription.");
        return;
      }
      const st = await fetch("/api/push/status").then(r => r.json());
      if (typeof st.devices === "number") setPushDevices(st.devices);
      setPushMsg("This device will buzz on new access requests.");
    } catch (e) {
      setPushMsg("Enable failed — try again.");
    } finally {
      setPushBusy(false);
    }
  };

  const saveVapidSettings = async () => {
    const put = (key: string, value: string) =>
      fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    await put("vapidPublicKey", vapidPublic);
    await put("vapidPrivateKey", vapidPrivate);
    await put("vapidSubject", vapidSubject);
    alert("Push keys saved! Note: rotating keys orphans existing devices — they re-subscribe on next admin visit.");
  };

  const generateVapid = async () => {
    setVapidBusy(true);
    try {
      const res = await fetch("/api/admin/push/vapid/generate", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setVapidPublic(data.publicKey || "");
        setVapidPrivate(data.privateKey || "");
        alert("Fresh pair generated — hit Save Keys to keep it.");
      } else {
        alert(data.error || "Generation failed.");
      }
    } catch {
      alert("Generation failed: no response.");
    } finally {
      setVapidBusy(false);
    }
  };

  const saveMusicSettings = async () => {
    const put = (key: string, value: string) =>
      fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    await put("spotifyClientId", spotifyId);
    await put("spotifyClientSecret", spotifySecret);
    await put("explicitSuffix", explicitSuffixOn ? "true" : "false");
    alert("Music links saved!");
  };

  const testSpotify = async () => {
    setMusicBusy(true);
    setMusicMsg("Contacting Spotify… (save first — the test reads saved values)");
    try {
      const res = await fetch("/api/admin/music/test", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMusicMsg(`Working — found "${data.sample}".`);
      } else {
        setMusicMsg(`Failed: ${data.error || "unknown error"}`);
      }
    } catch {
      setMusicMsg("Failed: no response.");
    } finally {
      setMusicBusy(false);
    }
  };

  const saveIdentitySettings = async () => {
    setIdBusy(true);
    setIdMsg("Saving — rebuilding (takes a minute)…");
    try {
      const res = await fetch("/api/admin/identity/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: idName,
          tagline: idTagline,
          description: idDescription,
          about: idAbout,
          backendUrl: idBackendUrl,
          donateUrl: idDonateUrl,
          nextauthUrl: idNextauthUrl,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setIdMsg("Saved. Station restarting with new branding — reload in a few seconds.");
      } else {
        setIdMsg(`Save failed: ${data.error || "unknown error"}`);
      }
    } catch {
      setIdMsg("Save failed: no response.");
    } finally {
      setIdBusy(false);
    }
  };

  const uploadBrand = async (kind: "logo" | "icon" | "background", inputId: string) => {
    const el = document.getElementById(inputId) as HTMLInputElement | null;
    const file = el?.files?.[0];
    if (!file) {
      setBrandMsg("Pick a file first.");
      return;
    }
    setBrandBusy(kind);
    setBrandMsg("");
    try {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", file);
      const res = await fetch("/api/admin/branding/upload", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBrandMsg(`Live now: ${(data.written || []).join(", ")}. Favicons cache hard — hard-refresh to see the tab icon.`);
        setBrandVersion(Date.now());
        if (el) el.value = "";
      } else {
        setBrandMsg(`Upload failed: ${data.error || "unknown error"}`);
      }
    } catch {
      setBrandMsg("Upload failed: no response.");
    } finally {
      setBrandBusy(null);
    }
  };

  const approveUser = async (userId: string) => {
    await fetch("/api/admin/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    fetchData();
  };

  const revokeUser = async (userId: string, name: string | null) => {
    if (!window.confirm(`Revoke ${name || "this user"}'s access? They go back to pending.`)) return;
    const res = await fetch("/api/admin/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) alert(data.error || "Revoke failed.");
    fetchData();
  };

  // Grant/revoke one booth permission per user. Admin implies the other two,
  // so promoting switches them on (and the UI greys them out).
  const setUserPerm = async (userId: string, patch: Record<string, boolean>, name: string | null) => {
    const res = await fetch("/api/admin/user-perms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...patch }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) alert(data.error || "Change failed.");
    else if (patch.isAdmin === true) alert(`${name || "User"} is now an admin.`);
    fetchData();
  };

  const removeUser = async (userId: string, name: string | null) => {
    if (!window.confirm(`Remove ${name || "this user"} entirely? Their sessions, likes and requests go too.`)) return;
    const res = await fetch("/api/admin/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) alert(data.error || "Remove failed.");
    fetchData();
  };

  if (status === "loading" || !(session?.user as any)?.isAdmin) {
    return <div className="container centered-column" style={{ justifyContent: "center" }}>Loading Admin...</div>;
  }

  return (
    <div className="container">
      <header id="header-admin" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3rem", flexWrap: "wrap", gap: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <img id="logo-img-admin" src={STATION.logo} alt={STATION.name} style={{ height: "48px", width: "auto", objectFit: "contain", filter: "drop-shadow(0px 4px 12px rgba(0,0,0,0.6))" }} />
          <h1 className="logo-text" style={{ margin: 0 }}>Admin Dashboard</h1>
        </div>
        <a id="btn-back-to-station" href="/" className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", width: "auto" }}>Back to Station</a>
      </header>

      <div id="admin-layout" className="admin-layout">
        <nav id="admin-tabs" className="admin-rail" aria-label="Admin sections">
          {([
            ["stats", "Stats", streamingUsers.length > 0 ? `${streamingUsers.length} live` : null],
            ["people", "People", pendingCount > 0 ? `${pendingCount} waiting` : null],
            ["station", "Station", null],
            ["services", "Services", null],
            ["system", "System", null],
            ["database", "Database", null],
          ] as [AdminTab, string, string | null][]).map(([key, label, badge]) => (
            <button
              key={key}
              id={`tab-${key}`}
              onClick={() => showTab(key)}
              aria-pressed={activeTab === key}
              className={activeTab === key ? "admin-tab active" : "admin-tab"}
            >
              <span>{label}</span>
              {badge && <span id={key === "people" ? "tab-pending-badge" : undefined} className="admin-tab-badge">{badge}</span>}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1, minWidth: 0 }}>

      <div className={`admin-panel ${tabPhase === "out" ? "phase-out" : "phase-in"}`} style={{ display: "flex", flexDirection: "column", gap: "3rem" }}>
        {/* Listeners — one roster: access, nicknames, listening, likes */}
        <section className="card" id="section-users" style={activeTab === "people" ? undefined : { display: "none" }}>
          <h2>Listeners</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Everyone with an account: access, nickname, time listened, likes.
          </p>
          <div style={{ marginTop: "1rem" }}>
            {users.length === 0 && <p className="about-text">No users yet.</p>}
            {users.map(user => {
              const st = stats.find((s: any) => s.userId === user.id);
              return (
              <div key={user.id} style={{ padding: "1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <strong>{user.name}</strong> ({user.email})
                    <span style={{ marginLeft: "0.5rem", fontSize: "0.8rem", color: "var(--color-muted)" }}>
                      {user.isAdmin ? "admin" : user.isApproved ? "approved" : "pending"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {!user.isApproved && (
                      <button id={`btn-approve-${user.id}`} className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={() => approveUser(user.id)}>
                        Approve
                      </button>
                    )}
                    {user.isApproved && (
                      <button id={`btn-revoke-${user.id}`} className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem", background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={() => revokeUser(user.id, user.name)}>
                        Revoke
                      </button>
                    )}
                    <button id={`btn-remove-${user.id}`} className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem", background: "#ef4444", color: "#fff" }} onClick={() => removeUser(user.id, user.name)}>
                      Remove
                    </button>
                  </div>
                </div>
                {/* Booth permissions. Admin implies all three grants, so the other three lock. */}
                <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.75rem" }}>
                  {([
                    ["isAdmin", "Admin"],
                    ["canUseDj", "Manual Voice DJ"],
                    ["canApprove", "Approve users"],
                    ["canUseSkills", "Run DJ skills"],
                  ] as [string, string][]).map(([key, label]) => {
                    const on = !!user[key];
                    const locked = key !== "isAdmin" && !!user.isAdmin;
                    return (
                      <button
                        key={key}
                        id={`btn-perm-${key}-${user.id}`}
                        role="switch"
                        aria-checked={on}
                        aria-label={`${label} for ${user.name}`}
                        disabled={locked}
                        title={locked ? "Admin already includes this" : undefined}
                        onClick={() => setUserPerm(user.id, { [key]: !on }, user.name)}
                        style={{ display: "flex", alignItems: "center", gap: "0.5rem", background: "transparent", border: "none", padding: 0, cursor: locked ? "default" : "pointer", opacity: locked ? 0.45 : 1, color: "var(--color-muted)", fontSize: "0.85rem", fontWeight: 600 }}
                      >
                        {label}
                        <span style={{ flexShrink: 0, width: "38px", height: "22px", borderRadius: "999px", backgroundColor: on ? "var(--color-accent)" : "rgba(255,255,255,0.18)", position: "relative", transition: "background-color 0.2s ease" }}>
                          <span style={{ position: "absolute", top: "2px", left: on ? "18px" : "2px", width: "18px", height: "18px", borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease" }} />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.75rem" }}>
                  <input
                    id={`input-nickname-${user.id}`}
                    type="text"
                    value={nickDrafts[user.id] ?? st?.user?.nickname ?? ""}
                    onChange={(e) => setNickDrafts(d => ({ ...d, [user.id]: e.target.value }))}
                    placeholder="Nickname (blank clears)"
                    className="input-field"
                    style={{ width: "220px", marginBottom: 0, padding: "0.5rem" }}
                  />
                  <button id={`btn-save-nickname-${user.id}`} className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem", fontSize: "0.875rem" }} onClick={() => saveNickname(user.id)}>
                    Save name
                  </button>
                </div>
                <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.5rem", fontSize: "0.9rem", color: "var(--color-muted)" }}>
                  <span>24h: <span style={{ color: "var(--color-text)" }}>{fmtDur(st?.day?.sec || 0)}</span></span>
                  <span>7d: <span style={{ color: "var(--color-text)" }}>{fmtDur(st?.week?.sec || 0)}</span></span>
                  <span>30d: <span style={{ color: "var(--color-text)" }}>{fmtDur(st?.month?.sec || 0)}</span></span>
                  <span>All-time: <span style={{ color: "var(--color-text)" }}>{fmtDur(st?.all?.sec || 0)} ({st?.all?.n || 0} plays)</span></span>
                  <span>Likes: <span style={{ color: "var(--color-text)" }}>{st?.likes || 0}</span></span>
                </div>
              </div>
              );
            })}
          </div>
        </section>

        {/* Now Streaming */}
        <section className="card" id="section-streaming" style={activeTab === "stats" ? undefined : { display: "none" }}>
          <h2>Now Streaming ({streamingUsers.length})</h2>
          <div style={{ marginTop: "1rem" }}>
            {streamingUsers.length === 0 && <p className="about-text">Nobody streaming right now.</p>}
            {streamingUsers.map((u: any) => {
              const mins = u.since ? Math.max(Math.round((Date.now() - new Date(u.since).getTime()) / 60000), 0) : null;
              const forStr = mins === null ? "" : mins < 1 ? "for <1m" : `for ${mins}m`;
              return (
              <div key={u.userId} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", padding: "0.75rem 1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div><strong>{u.name}</strong> <span style={{ fontSize: "0.8rem", color: "var(--color-accent)" }}>● streaming {forStr}</span></div>
                <div style={{ fontSize: "0.85rem", color: "var(--color-muted)" }}>{u.email}</div>
              </div>
              );
            })}
          </div>
        </section>

        {/* Now Signed In */}
        <section className="card" id="section-signed-in" style={activeTab === "stats" ? undefined : { display: "none" }}>
          <h2>Now Signed In ({signedInUsers.length})</h2>
          <div style={{ marginTop: "1rem" }}>
            {signedInUsers.length === 0 && <p className="about-text">Nobody signed in right now.</p>}
            {signedInUsers.map((u: any) => {
              const agoSec = u.lastSeen ? Math.max(Math.round((Date.now() - new Date(u.lastSeen).getTime()) / 1000), 0) : null;
              const ago = agoSec === null ? "" : agoSec < 60 ? `active ${agoSec}s ago` : `active ${Math.floor(agoSec / 60)}m ago`;
              return (
              <div key={u.userId} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", padding: "0.75rem 1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div><strong>{u.name}</strong> <span style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>{ago}</span></div>
                <div style={{ fontSize: "0.85rem", color: "var(--color-muted)" }}>{u.email}</div>
              </div>
              );
            })}
          </div>
        </section>

        {/* Google Sign-In */}
        <CollapsibleSection
          id="section-auth-settings"
          title={<>Google Sign-In</>}
          summary={<>Saving restarts the station (a few seconds; listeners reconnect). A matching sign-in is auto-approved as admin — changing the email does not demote the previous one. NEXTAUTH_SECRET stays server-env only.</>}
          hidden={activeTab !== "station"}
        >
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-google-id" style={{ display: "block", marginBottom: "0.5rem" }}>Google Client ID{envTag('googleClientId')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>OAuth app id — who this site is to Google. See setup guide.</div>
              <input
                id="input-google-id"
                type="text"
                value={googleClientId}
                onChange={(e) => setGoogleClientId(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="input-google-secret" style={{ display: "block", marginBottom: "0.5rem" }}>Google Client Secret{envTag('googleClientSecret')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>OAuth app secret. Never share; wrong values break all logins.</div>
              <input
                id="input-google-secret"
                type="password"
                value={googleClientSecret}
                onChange={(e) => setGoogleClientSecret(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label htmlFor="input-admin-email" style={{ display: "block", marginBottom: "0.5rem" }}>Admin Email{envTag('adminEmail')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Sign-ins matching this address auto-approve as admin. Does not demote the old one.</div>
              <input
                id="input-admin-email"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="off"
              />
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button id="btn-save-auth" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveAuthSettings}>
              Save
            </button>
            <button id="btn-test-auth" className="primary-btn" style={{ width: "150px", padding: "0.5rem", background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={testAuth} disabled={authBusy}>
              {authBusy ? "Testing…" : "Test"}
            </button>
            </div>
            {authMsg && <div id="auth-save-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{authMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* Station Identity */}
        <CollapsibleSection
          id="section-identity-settings"
          title={<>Station Identity</>}
          summary={<>Baked in at build time — saving rebuilds and restarts the station (a minute or so). NEXTAUTH_SECRET, DATABASE_URL and PM2_APP_NAME stay server-env only.</>}
          hidden={activeTab !== "station"}
        >
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-id-name" style={{ display: "block", marginBottom: "0.5rem" }}>Station Name</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Site title, PWA name, push sender, lock-screen label.</div>
              <input id="input-id-name" type="text" value={idName} onChange={(e) => setIdName(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <div>
              <label htmlFor="input-id-tagline" style={{ display: "block", marginBottom: "0.5rem" }}>Tagline</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Short line under the logo.</div>
              <input id="input-id-tagline" type="text" value={idTagline} onChange={(e) => setIdTagline(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <div>
              <label htmlFor="input-id-description" style={{ display: "block", marginBottom: "0.5rem" }}>Short Description</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Search/share metadata and PWA description.</div>
              <input id="input-id-description" type="text" value={idDescription} onChange={(e) => setIdDescription(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <div>
              <label htmlFor="input-id-about" style={{ display: "block", marginBottom: "0.5rem" }}>About (sign-in card)</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Paragraph guests read before signing in.</div>
              <textarea id="input-id-about" value={idAbout} onChange={(e) => setIdAbout(e.target.value)} className="input-field" rows={3} style={{ width: "100%", maxWidth: "400px", resize: "vertical", fontFamily: "inherit" }} />
            </div>
            <div>
              <label htmlFor="input-id-backend" style={{ display: "block", marginBottom: "0.5rem" }}>Public Backend URL</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>What listeners' browsers call (covers, now-playing). The Server card below is what this machine calls — usually the same host, different route.</div>
              <input id="input-id-backend" type="text" value={idBackendUrl} onChange={(e) => setIdBackendUrl(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <div>
              <label htmlFor="input-id-donate" style={{ display: "block", marginBottom: "0.5rem" }}>Fallback Donate URL</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Support button link until the Support card saves one.</div>
              <input id="input-id-donate" type="text" value={idDonateUrl} onChange={(e) => setIdDonateUrl(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <div>
              <label htmlFor="input-id-nextauth" style={{ display: "block", marginBottom: "0.5rem" }}>App URL (must match Google console)</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>This site origin — OAuth callbacks fail if it differs from Google console.</div>
              <input id="input-id-nextauth" type="text" value={idNextauthUrl} onChange={(e) => setIdNextauthUrl(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} />
            </div>
            <button id="btn-save-identity" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveIdentitySettings} disabled={idBusy}>
              {idBusy ? "Rebuilding…" : "Save"}
            </button>
            {idMsg && <div id="identity-save-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{idMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* Branding */}
        <CollapsibleSection
          id="section-branding"
          title={<>Branding</>}
          summary={<>Images go live instantly — no rebuild. Logo also regenerates every icon + tab favicon.</>}
          hidden={activeTab !== "station"}
        >
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            {([["logo", "Logo"], ["icon", "Icons"], ["background", "Backdrop"]] as const).map(([key, label]) => (
              <button
                key={key}
                id={`tab-brand-${key}`}
                onClick={() => setBrandTab(key)}
                aria-selected={brandTab === key}
                className="primary-btn"
                style={{
                  width: "auto", padding: "0.5rem 1.25rem", fontSize: "0.875rem",
                  background: brandTab === key ? "var(--color-text)" : "rgba(255,255,255,0.08)",
                  color: brandTab === key ? "var(--color-bg)" : "var(--color-text)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            {brandTab === "logo" && (
              <>
                <img id="brand-preview-logo" src={`/brand/logo.png?v=${brandVersion}`} alt="Current logo" style={{ height: "80px", width: "auto", maxWidth: "100%", objectFit: "contain", alignSelf: "flex-start", background: "rgba(0,0,0,0.25)", borderRadius: "8px", padding: "8px" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Header, sign-in, covers fallback — also rebuilds every icon.</div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <input id="input-brand-logo" type="file" accept="image/*" className="input-field" style={{ maxWidth: "280px", marginBottom: 0 }} />
                  <button id="btn-upload-logo" className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={() => uploadBrand("logo", "input-brand-logo")} disabled={brandBusy !== null}>
                    {brandBusy === "logo" ? "Uploading…" : "Upload"}
                  </button>
                </div>
              </>
            )}
            {brandTab === "icon" && (
              <>
                <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
                  <img id="brand-preview-icon" src={`/brand/icons/icon-192.png?v=${brandVersion}`} alt="Current icon" style={{ width: "72px", height: "72px", borderRadius: "16px" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  <img id="brand-preview-icon-maskable" src={`/brand/icons/icon-192-maskable.png?v=${brandVersion}`} alt="Current maskable icon" style={{ width: "72px", height: "72px", borderRadius: "50%" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Tab + homescreen set. Keeps the current logo.</div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <input id="input-brand-icon" type="file" accept="image/*" className="input-field" style={{ maxWidth: "280px", marginBottom: 0 }} />
                  <button id="btn-upload-icon" className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={() => uploadBrand("icon", "input-brand-icon")} disabled={brandBusy !== null}>
                    {brandBusy === "icon" ? "Uploading…" : "Upload"}
                  </button>
                </div>
              </>
            )}
            {brandTab === "background" && (
              <>
                <img id="brand-preview-bg" src={`/brand/bg.jpg?v=${brandVersion}`} alt="Current backdrop" style={{ width: "100%", maxWidth: "400px", height: "140px", objectFit: "cover", borderRadius: "8px" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                <div style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Scenic backdrop behind everything.</div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                  <input id="input-brand-bg" type="file" accept="image/*" className="input-field" style={{ maxWidth: "280px", marginBottom: 0 }} />
                  <button id="btn-upload-bg" className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={() => uploadBrand("background", "input-brand-bg")} disabled={brandBusy !== null}>
                    {brandBusy === "background" ? "Uploading…" : "Upload"}
                  </button>
                </div>
              </>
            )}
            {brandMsg && <div id="brand-upload-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{brandMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* Push Notifications */}
        <CollapsibleSection
          id="section-push"
          title={<>Push Notifications</>}
          summary={<>New access requests buzz the devices below. iOS only delivers to the installed homescreen app, not a Safari tab.</>}
          hidden={activeTab !== "services"}
        >
          <div style={{ marginTop: "1rem", display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <button id="btn-enable-push" className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={enablePush}>
              {pushBusy ? "Enabling…" : "Enable on this device"}
            </button>
            <span style={{ fontSize: "0.9rem", color: "var(--color-muted)" }}>{pushDevices} device(s) registered</span>
          </div>
          {pushMsg && <div id="push-status-msg" style={{ marginTop: "0.75rem", color: "var(--color-accent)", fontSize: "0.875rem" }}>{pushMsg}</div>}
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-vapid-public" style={{ display: "block", marginBottom: "0.5rem" }}>VAPID Public Key{envTag('vapidPublicKey')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Identifies this server to push services. Generate once, keep.</div>
              <input id="input-vapid-public" type="text" value={vapidPublic} onChange={(e) => setVapidPublic(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="input-vapid-private" style={{ display: "block", marginBottom: "0.5rem" }}>VAPID Private Key{envTag('vapidPrivateKey')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Signs pushes. Rotating orphans devices until they re-subscribe.</div>
              <input id="input-vapid-private" type="password" value={vapidPrivate} onChange={(e) => setVapidPrivate(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} autoComplete="new-password" />
            </div>
            <div>
              <label htmlFor="input-vapid-subject" style={{ display: "block", marginBottom: "0.5rem" }}>VAPID Subject (mailto){envTag('vapidSubject')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Contact push services show on abuse complaints.</div>
              <input id="input-vapid-subject" type="text" value={vapidSubject} onChange={(e) => setVapidSubject(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} autoComplete="off" />
            </div>
            <button id="btn-save-vapid" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveVapidSettings}>
              Save Keys
            </button>
            <button
              id="btn-generate-vapid"
              className="primary-btn"
              style={{ width: "150px", padding: "0.5rem", background: "rgba(255,255,255,0.1)", color: "#fff", opacity: vapidPublic ? 0.45 : 1 }}
              onClick={generateVapid}
              disabled={vapidBusy || !!vapidPublic}
              title={vapidPublic ? "Keys already set — clear the fields to rotate" : "Generate a fresh pair"}
            >
              {vapidBusy ? "Generating…" : "Generate"}
            </button>
          </div>
        </CollapsibleSection>

        {/* Music Links */}
        <CollapsibleSection
          id="section-music-settings"
          title={<>Music Links <span style={{ fontWeight: 400, fontSize: "0.9rem", color: "var(--color-muted)" }}>(optional)</span></>}
          summary={<>Spotify OAuth for exact track links (Apple needs none). Without keys, buttons fall back to search pages. Applies on next lookup.</>}
          hidden={activeTab !== "services"}
        >
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-spotify-id" style={{ display: "block", marginBottom: "0.5rem" }}>Spotify Client ID{envTag('spotifyClientId')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Exact track links. Apple needs no keys. See setup guide.</div>
              <input id="input-spotify-id" type="text" value={spotifyId} onChange={(e) => setSpotifyId(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="input-spotify-secret" style={{ display: "block", marginBottom: "0.5rem" }}>Spotify Client Secret{envTag('spotifyClientSecret')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Pairs with the client ID for Spotify API auth.</div>
              <input id="input-spotify-secret" type="password" value={spotifySecret} onChange={(e) => setSpotifySecret(e.target.value)} className="input-field" style={{ width: "100%", maxWidth: "400px" }} autoComplete="new-password" />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", maxWidth: "400px" }}>
              <span id="explicit-suffix-label" style={{ fontSize: "0.9rem" }}>Explicit 🅴 tag on lock-screen titles</span>
              <button
                id="toggle-explicit-suffix"
                role="switch"
                aria-checked={explicitSuffixOn}
                aria-labelledby="explicit-suffix-label"
                onClick={() => setExplicitSuffixOn(o => !o)}
                style={{
                  flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
                  backgroundColor: explicitSuffixOn ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                  position: "relative", transition: "background-color 0.2s ease", padding: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: "2px", left: explicitSuffixOn ? "23px" : "2px", width: "23px", height: "23px",
                  borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                }} />
              </button>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button id="btn-save-music" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveMusicSettings}>
              Save
            </button>
            <button id="btn-test-spotify" className="primary-btn" style={{ width: "150px", padding: "0.5rem", background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={testSpotify} disabled={musicBusy}>
              {musicBusy ? "Testing…" : "Test"}
            </button>
            </div>
            {musicMsg && <div id="music-test-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{musicMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* Donations. Under Stats, not Services — this is a readout of money
            taken, not a station service you configure. The Support Button
            section carries a link here. */}
        <section className="card" id="section-donations" style={showDonationsSection ? undefined : { display: "none" }}>
          <h2>Donations</h2>
          <div style={{ marginTop: "1rem" }}>
            {donations.length === 0 && <p className="about-text">No donations recorded.</p>}
            {donations.map((d, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div>
                  <strong>{d.supporterEmail}</strong>
                  {d.message && <div style={{ fontSize: "0.875rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>"{d.message}"</div>}
                </div>
                <div>
                  <strong>{d.amount} {d.currency}</strong>
                  <div style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>{new Date(d.receivedAt).toLocaleDateString()}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Support Button */}
        <CollapsibleSection
          id="section-support-settings"
          title={<>Support Button</>}
          summary={<>The tip button on the player, and the webhook secret that verifies donations are really from Buy Me A Coffee. The donations themselves are listed under Stats.</>}
          hidden={activeTab !== "services"}
        >
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <span id="support-enabled-label">Show support button</span>
              <button
                id="toggle-support-enabled"
                role="switch"
                aria-checked={donateOn}
                aria-labelledby="support-enabled-label"
                onClick={() => setDonateOn(o => !o)}
                style={{
                  flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
                  backgroundColor: donateOn ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                  position: "relative", transition: "background-color 0.2s ease", padding: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: "2px", left: donateOn ? "23px" : "2px", width: "23px", height: "23px",
                  borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                }} />
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateRows: donateOn ? "1fr" : "0fr", transition: "grid-template-rows 0.25s ease", overflow: "hidden" }}>
              <div style={{ overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-support-url" style={{ display: "block", marginBottom: "0.5rem" }}>Support Button URL{envTag('donate_url')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Where the tip button sends listeners.</div>
              <input
                id="input-support-url"
                type="text"
                value={donateUrl}
                onChange={(e) => setDonateUrl(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
              />
            </div>
            <div>
              <label htmlFor="input-support-text" style={{ display: "block", marginBottom: "0.5rem" }}>Support Button Text{envTag('donate_text')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Label on the tip button.</div>
              <input
                id="input-support-text"
                type="text"
                value={donateText}
                onChange={(e) => setDonateText(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
              />
            </div>
              </div>
            </div>
            <div>
              <label htmlFor="input-bmac-webhook-url" style={{ display: "block", marginBottom: "0.35rem" }}>
                Buy Me A Coffee webhook address
              </label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginBottom: "0.5rem" }}>
                Paste this into your Buy Me A Coffee webhook settings. It is where the service
                posts each donation.
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <input
                  id="input-bmac-webhook-url"
                  type="text"
                  readOnly
                  className="input-field"
                  value={bmacWebhookUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ width: "100%", maxWidth: "460px", fontFamily: "monospace", fontSize: "0.85rem" }}
                />
                <button
                  id="btn-copy-bmac-webhook-url"
                  className="primary-btn"
                  style={{ width: "auto", padding: "0.5rem 0.9rem", fontSize: "0.85rem" }}
                  onClick={copyWebhookUrl}
                >
                  {webhookCopied ? "Copied" : "Copy"}
                </button>
              </div>

              {/* Only BMAC is supported, and it is only believed because of the
                  signed body — so say both, rather than leaving the operator to
                  assume some other service might also work. */}
              <div style={{ marginTop: "0.6rem", fontSize: "0.8rem", color: "var(--color-muted)", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                <span>
                  Buy Me A Coffee is the only donation source wired up. Other services posting
                  to this address will be rejected.
                </span>
                {webhook && (
                  <span style={{ color: webhook.configured ? "var(--color-accent)" : "var(--color-accent-warm)", fontWeight: 600 }}>
                    {webhook.configured
                      ? `Receiving donations — secret is set (from ${webhook.source === "env" ? "server env" : "the database"}).`
                      : "Not receiving donations — no webhook secret is set, so every payload is rejected."}
                  </span>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="input-bmac-secret" style={{ display: "block", marginBottom: "0.5rem" }}>Buy Me A Coffee Webhook Secret{envTag('bmacWebhookSecret')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>
                Buy Me A Coffee signs every payload with this secret; it is what proves a
                donation is genuinely from them rather than anyone who found the address.
                Anything without a matching signature is refused. Setting it here stores it
                unencrypted in the database — server env is safer.
              </div>
              <input
                id="input-bmac-secret"
                type="password"
                value={bmacSecret}
                onChange={(e) => setBmacSecret(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="new-password"
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
              <button id="btn-save-support" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveSupportSettings}>
                Save
              </button>
              {/* Donations moved to Stats, where a money readout belongs rather
                  than among the services you configure. Point there instead of
                  duplicating the list in two places. */}
              <button
                id="btn-goto-donations"
                className="primary-btn"
                onClick={() => showTab("stats")}
                style={{ width: "auto", padding: "0.5rem 1rem", background: "rgba(255,255,255,0.1)", color: "#fff" }}
              >
                View donations →
              </button>
            </div>
          </div>
        </CollapsibleSection>

        {/* Maintenance Mode */}
        <section className="card" id="section-maintenance" style={activeTab === "system" ? undefined : { display: "none" }}>
          <h2>Maintenance Mode</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Hides the player from signed-in listeners and blocks new streams. Admins still see the player so they can verify. Applies immediately, no restart.
          </p>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <span id="maintenance-enabled-label">Maintenance mode</span>
              <button
                id="toggle-maintenance-enabled"
                role="switch"
                aria-checked={maintOn}
                aria-labelledby="maintenance-enabled-label"
                onClick={() => setMaintOn(o => !o)}
                style={{
                  flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
                  backgroundColor: maintOn ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                  position: "relative", transition: "background-color 0.2s ease", padding: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: "2px", left: maintOn ? "23px" : "2px", width: "23px", height: "23px",
                  borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                }} />
              </button>
            </div>
            <div>
              <label htmlFor="input-maintenance-message" style={{ display: "block", marginBottom: "0.5rem" }}>Notice text (optional)</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Shown to listeners instead of the player. Blank shows a default.</div>
              <textarea
                id="input-maintenance-message"
                value={maintText}
                onChange={(e) => setMaintText(e.target.value)}
                className="input-field"
                rows={3}
                maxLength={500}
                style={{ width: "100%", maxWidth: "400px", resize: "vertical", fontFamily: "inherit" }}
              />
            </div>
            <button id="btn-save-maintenance" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveMaintenance} disabled={maintBusy}>
              Save
            </button>
            <button id="btn-preview-maintenance" className="primary-btn" style={{ width: "150px", padding: "0.5rem", background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={() => setMaintPreview(v => !v)}>
              {maintPreview ? "Hide preview" : "Preview"}
            </button>
            {maintPreview && (
              <div id="maintenance-notice-preview" className="card" style={{ textAlign: "center", padding: "2rem", maxWidth: "400px" }}>
                <h2 style={{ marginBottom: "1rem" }}>Station under maintenance</h2>
                <p style={{ color: "var(--color-muted)", fontSize: "1rem", margin: 0 }}>
                  {maintText || "Down for maintenance — back soon."}
                </p>
              </div>
            )}
            {maintMsg && <div id="maintenance-save-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{maintMsg}</div>}
          </div>
        </section>

        {/* Diagnostics */}
        {/* Database — engine, permissions, copy, switch */}
        <section className="card" id="section-database" style={activeTab === "database" ? undefined : { display: "none" }}>
          <DatabasePanel />
        </section>

        <section className="card" id="section-diagnostics" style={activeTab === "system" ? undefined : { display: "none" }}>
          <h2>Diagnostics</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Verbose player console logs (feed, audio, links, requests). Applies on next page load. Errors always log regardless.
          </p>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <span id="verbose-enabled-label">Verbose browser logging</span>
              <button
                id="toggle-verbose-enabled"
                role="switch"
                aria-checked={verboseOn}
                aria-labelledby="verbose-enabled-label"
                onClick={() => setVerboseOn(o => !o)}
                style={{
                  flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
                  backgroundColor: verboseOn ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                  position: "relative", transition: "background-color 0.2s ease", padding: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: "2px", left: verboseOn ? "23px" : "2px", width: "23px", height: "23px",
                  borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                }} />
              </button>
            </div>
            <button id="btn-save-verbose" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveVerbose} disabled={verboseBusy}>
              Save
            </button>
            {verboseMsg && <div id="verbose-save-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{verboseMsg}</div>}
          </div>
        </section>

        {/* Sub/Wave Server */}
        <CollapsibleSection
          id="section-server-settings"
          title={<>Sub/Wave Server</>}
          summary={<>Backend the stream, requests, skip and never-play talk to. Falls back to server env when blank.</>}
          hidden={activeTab !== "station"}
        >
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-subwave-url" style={{ display: "block", marginBottom: "0.5rem" }}>Server Address (API base URL — /api added if missing){envTag('subwaveApiUrl')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>What this machine calls (proxies, sync). The Identity card above is what listeners' browsers call — same backend, different leg.</div>
              <input
                id="input-subwave-url"
                type="text"
                value={subwaveApiUrl}
                onChange={(e) => setSubwaveApiUrl(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                placeholder="https://radio.example.com/api"
              />
            </div>
            <div>
              <label htmlFor="input-subwave-user" style={{ display: "block", marginBottom: "0.5rem" }}>Username (Sub/Wave ADMIN_USER){envTag('subwaveAdminUser')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Backend admin user — powers skip and never-play forwarding.</div>
              <input
                id="input-subwave-user"
                type="text"
                value={subwaveAdminUser}
                onChange={(e) => setSubwaveAdminUser(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="input-subwave-pass" style={{ display: "block", marginBottom: "0.5rem" }}>Password (Sub/Wave ADMIN_PASS){envTag('subwaveAdminPass')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Backend admin password. Same use as username.</div>
              <input
                id="input-subwave-pass"
                type="password"
                value={subwaveAdminPass}
                onChange={(e) => setSubwaveAdminPass(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label htmlFor="input-station-password" style={{ display: "block", marginBottom: "0.5rem" }}>Station Password (for stream auth){envTag('stationPassword')}</label>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>Listener password: stream proxy auth and the relay master password (synced on save).</div>
              <input
                id="input-station-password"
                type="password"
                value={stationPassword}
                onChange={(e) => setStationPassword(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
                placeholder="Station password"
              />
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button id="btn-save-server" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveServerSettings}>
              Save
            </button>
            <button id="btn-test-server" className="primary-btn" style={{ width: "150px", padding: "0.5rem", background: "rgba(255,255,255,0.1)", color: "#fff" }} onClick={testServer} disabled={serverBusy}>
              {serverBusy ? "Testing…" : "Test"}
            </button>
            </div>
            {serverMsg && <div id="server-sync-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{serverMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* Stream Mode */}
        <CollapsibleSection
          id="section-stream-mode"
          title={<>Stream Mode</>}
          summary={<>How listeners receive audio. Backend reports {backendListeners === null ? "…" : <strong>{backendListeners} listening</strong>} right now.</>}
          hidden={activeTab !== "station"}
        >
          {/* Read-only: this value belongs to the Sub/Wave host. The player
              reads it live for the display delay, song countdown and skip
              lock, so it is shown here for reference only. */}
          <div
            id="buffer-readout"
            style={{ marginTop: "0.75rem", padding: "0.75rem 1rem", border: "1px solid var(--color-border)", borderRadius: "var(--radius)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                Stream buffer: {backendBuffer === null ? "…" : `${backendBuffer}s`}
              </div>
              <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.25rem" }}>
                How far behind the studio each listener is. Set it in Sub/Wave under Stream settings — this app only reads it. Higher is
                kinder to shaky connections, but adds the same delay to everything.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <button
              id="btn-mode-relay"
              onClick={() => saveStreamMode("relay")}
              aria-pressed={streamMode === "relay"}
              className="primary-btn"
              style={{ width: "auto", padding: "0.5rem 1.25rem", background: streamMode === "relay" ? "var(--color-text)" : "rgba(255,255,255,0.08)", color: streamMode === "relay" ? "var(--color-bg)" : "var(--color-text)" }}
            >
              1-to-many relay
            </button>
            <button
              id="btn-mode-direct"
              onClick={() => saveStreamMode("direct")}
              aria-pressed={streamMode === "direct"}
              className="primary-btn"
              style={{ width: "auto", padding: "0.5rem 1.25rem", background: streamMode === "direct" ? "var(--color-text)" : "rgba(255,255,255,0.08)", color: streamMode === "direct" ? "var(--color-bg)" : "var(--color-text)" }}
            >
              1-to-1 direct
            </button>
          </div>
          <div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "var(--color-muted)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {streamMode === "relay" ? (
              <span>One upstream connection feeds every listener. Backend counts relay sockets (all proxy addresses); per-listener identity lives here in Signed In.</span>
            ) : (
              <>
                <span>Each player connects straight to the master — the backend sees true counts and real IPs natively.</span>
                <span>Costs: backend upload scales per listener, and the station password ships in page JS (approved eyes only — rotate it if shared).</span>
              </>
            )}
            <span>Applies on next Play; current listeners keep their path until they re-tune.</span>
          </div>
        </CollapsibleSection>

        {/* Skip button visibility. The player hides the button and /api/skip
            refuses independently, both reading lib/skipvisibility.ts — so this
            control is one switch, not three places to keep in step. */}
        <CollapsibleSection
          id="section-skip-control"
          title={<>Skip Control</>}
          summary={<>Who gets the Skip button on the player. Admins always see it, whatever this is set to.</>}
          hidden={activeTab !== "station"}
        >
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {SKIP_VISIBILITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                id={`btn-skip-visibility-${opt.value}`}
                onClick={() => saveSkipVisibility(opt.value)}
                aria-pressed={skipVisibility === opt.value}
                className="primary-btn"
                style={{
                  width: "auto",
                  padding: "0.5rem 1.25rem",
                  background: skipVisibility === opt.value ? "var(--color-text)" : "rgba(255,255,255,0.08)",
                  color: skipVisibility === opt.value ? "var(--color-bg)" : "var(--color-text)",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ marginTop: "1rem", fontSize: "0.875rem", color: "var(--color-muted)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <span>{SKIP_VISIBILITY_OPTIONS.find((o) => o.value === skipVisibility)?.blurb}</span>
            <span>Admins always see Skip — this only governs listeners. Takes effect on their next page load.</span>
          </div>
        </CollapsibleSection>
        </div>
      </div>
      </div>
    </div>
  );
}
