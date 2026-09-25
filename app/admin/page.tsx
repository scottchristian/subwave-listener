"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { STATION } from "@/lib/station";

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  const [users, setUsers] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [nickDrafts, setNickDrafts] = useState<Record<string, string>>({});
  const [donations, setDonations] = useState<any[]>([]);
  const [donateUrl, setDonateUrl] = useState(STATION.donateUrl);
  const [donateText, setDonateText] = useState("Send a tip to keep the station alive ☕");
  const [stationPassword, setStationPassword] = useState("");
  const [subwaveApiUrl, setSubwaveApiUrl] = useState("");
  const [subwaveAdminUser, setSubwaveAdminUser] = useState("");
  const [subwaveAdminPass, setSubwaveAdminPass] = useState("");
  const [serverMsg, setServerMsg] = useState("");
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const [pushDevices, setPushDevices] = useState(0);
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
    if (status === "authenticated" && !(session?.user as any)?.isAdmin) {
      router.push("/");
    }
    
    if (status === "authenticated" && (session?.user as any)?.isAdmin) {
      fetchData();
      fetch("/api/push/status")
        .then(r => r.json())
        .then(d => { if (typeof d.devices === "number") setPushDevices(d.devices); })
        .catch(() => {});
    }
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
      if (setRes.ok) {
        const settings = await setRes.json();
        const dUrl = settings.find((s: any) => s.key === "donate_url");
        if (dUrl) setDonateUrl(dUrl.value);
        const dText = settings.find((s: any) => s.key === "donate_text");
        if (dText) setDonateText(dText.value);
        const sPass = settings.find((s: any) => s.key === "stationPassword");
        if (sPass) setStationPassword(sPass.value);
        const apiUrl = settings.find((s: any) => s.key === "subwaveApiUrl");
        if (apiUrl) setSubwaveApiUrl(apiUrl.value);
        const adminUser = settings.find((s: any) => s.key === "subwaveAdminUser");
        if (adminUser) setSubwaveAdminUser(adminUser.value);
        const adminPass = settings.find((s: any) => s.key === "subwaveAdminPass");
        if (adminPass) setSubwaveAdminPass(adminPass.value);
        const gId = settings.find((s: any) => s.key === "googleClientId");
        if (gId) setGoogleClientId(gId.value);
        const gSecret = settings.find((s: any) => s.key === "googleClientSecret");
        if (gSecret) setGoogleClientSecret(gSecret.value);
        const aEmail = settings.find((s: any) => s.key === "adminEmail");
        if (aEmail) setAdminEmail(aEmail.value);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const saveSupportSettings = async () => {
    await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "donate_url", value: donateUrl }),
    });
    await fetch("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "donate_text", value: donateText }),
    });
    alert("Support button saved!");
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
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "3rem" }}>
        <h1 className="logo-text">Admin Dashboard</h1>
        <a id="btn-back-to-station" href="/" className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", width: "auto" }}>Back to Station</a>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: "3rem" }}>
        {/* Users */}
        <section className="card" id="section-users">
          <h2>Users</h2>
          <div style={{ marginTop: "1rem" }}>
            {users.length === 0 && <p className="about-text">No users yet.</p>}
            {users.map(user => (
              <div key={user.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", padding: "1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div>
                  <strong>{user.name}</strong> ({user.email})
                  <span style={{ marginLeft: "0.5rem", fontSize: "0.8rem", color: "var(--color-muted)" }}>
                    {user.isAdmin ? "admin" : user.isApproved ? "approved" : "pending"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
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
            ))}
          </div>
        </section>

        {/* User Stats */}
        <section className="card" id="section-user-stats">
          <h2>User Stats</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Time listened per user, rolling windows. Overlapping plays merge (each press logs ~2 rows); live sessions count while open, abandoned rows count 0.
          </p>
          <div style={{ marginTop: "1rem" }}>
            {stats.length === 0 && <p className="about-text">No listening stats recorded.</p>}
            {stats.map((s: any) => (
              <div key={s.userId} style={{ padding: "1rem", borderBottom: "1px solid var(--color-border)" }}>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  <div>
                    <strong>{s.user?.name}</strong> ({s.user?.email})
                  </div>
                  <input
                    id={`input-nickname-${s.userId}`}
                    type="text"
                    value={nickDrafts[s.userId] ?? s.user?.nickname ?? ""}
                    onChange={(e) => setNickDrafts(d => ({ ...d, [s.userId]: e.target.value }))}
                    placeholder="Nickname (blank clears)"
                    className="input-field"
                    style={{ width: "220px", marginBottom: 0, padding: "0.5rem" }}
                  />
                  <button id={`btn-save-nickname-${s.userId}`} className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem", fontSize: "0.875rem" }} onClick={() => saveNickname(s.userId)}>
                    Save name
                  </button>
                </div>
                <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.5rem", fontSize: "0.95rem" }}>
                  <span><span style={{ color: "var(--color-muted)" }}>24h: </span>{fmtDur(s.day?.sec || 0)}</span>
                  <span><span style={{ color: "var(--color-muted)" }}>7d: </span>{fmtDur(s.week?.sec || 0)}</span>
                  <span><span style={{ color: "var(--color-muted)" }}>30d: </span>{fmtDur(s.month?.sec || 0)}</span>
                  <span><span style={{ color: "var(--color-muted)" }}>All-time: </span>{fmtDur(s.all?.sec || 0)} ({s.all?.n || 0} sessions)</span>
                  <span><span style={{ color: "var(--color-muted)" }}>Likes: </span>{s.likes || 0} songs</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Google Sign-In */}
        <section className="card" id="section-auth-settings">
          <h2>Google Sign-In</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Saving restarts the station (a few seconds; listeners reconnect). A matching sign-in is auto-approved as admin — changing the email does not demote the previous one. NEXTAUTH_SECRET stays server-env only.
          </p>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-google-id" style={{ display: "block", marginBottom: "0.5rem" }}>Google Client ID</label>
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
              <label htmlFor="input-google-secret" style={{ display: "block", marginBottom: "0.5rem" }}>Google Client Secret</label>
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
              <label htmlFor="input-admin-email" style={{ display: "block", marginBottom: "0.5rem" }}>Admin Email</label>
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
            <button id="btn-save-auth" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveAuthSettings}>
              Save
            </button>
            {authMsg && <div id="auth-save-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{authMsg}</div>}
          </div>
        </section>

        {/* Push Notifications */}
        <section className="card" id="section-push">
          <h2>Push Notifications</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            New access requests buzz the devices below. iOS only delivers to the installed homescreen app, not a Safari tab.
          </p>
          <div style={{ marginTop: "1rem", display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <button id="btn-enable-push" className="primary-btn" style={{ width: "auto", padding: "0.5rem 1rem" }} onClick={enablePush}>
              {pushBusy ? "Enabling…" : "Enable on this device"}
            </button>
            <span style={{ fontSize: "0.9rem", color: "var(--color-muted)" }}>{pushDevices} device(s) registered</span>
          </div>
          {pushMsg && <div id="push-status-msg" style={{ marginTop: "0.75rem", color: "var(--color-accent)", fontSize: "0.875rem" }}>{pushMsg}</div>}
        </section>

        {/* Donations */}
        <section className="card">
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
        <section className="card" id="section-support-settings">
          <h2>Support Button</h2>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-support-url" style={{ display: "block", marginBottom: "0.5rem" }}>Support Button URL</label>
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
              <label htmlFor="input-support-text" style={{ display: "block", marginBottom: "0.5rem" }}>Support Button Text</label>
              <input
                id="input-support-text"
                type="text"
                value={donateText}
                onChange={(e) => setDonateText(e.target.value)}
                className="input-field"
                style={{ width: "100%", maxWidth: "400px" }}
              />
            </div>
            <button id="btn-save-support" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveSupportSettings}>
              Save
            </button>
          </div>
        </section>

        {/* Sub/Wave Server */}
        <section className="card" id="section-server-settings">
          <h2>Sub/Wave Server</h2>
          <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            Backend the stream, requests, skip and never-play talk to. Falls back to server env when blank.
          </p>
          <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div>
              <label htmlFor="input-subwave-url" style={{ display: "block", marginBottom: "0.5rem" }}>Server Address (API base URL — /api added if missing)</label>
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
              <label htmlFor="input-subwave-user" style={{ display: "block", marginBottom: "0.5rem" }}>Username (Sub/Wave ADMIN_USER)</label>
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
              <label htmlFor="input-subwave-pass" style={{ display: "block", marginBottom: "0.5rem" }}>Password (Sub/Wave ADMIN_PASS)</label>
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
              <label htmlFor="input-station-password" style={{ display: "block", marginBottom: "0.5rem" }}>Station Password (for stream auth)</label>
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
            <button id="btn-save-server" className="primary-btn" style={{ width: "150px", padding: "0.5rem" }} onClick={saveServerSettings}>
              Save
            </button>
            {serverMsg && <div id="server-sync-msg" style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{serverMsg}</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
