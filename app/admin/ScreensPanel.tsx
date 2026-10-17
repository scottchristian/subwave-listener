"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Wall screens: add one, build it, flash it, and see whether it is alive.
 *
 * THE FLOW, AND WHY IT IS THE FLOW IT IS. No server here can compile firmware —
 * the app host has no container runtime and 1.7GB of RAM, the station host is 99%
 * full, and an ESP-IDF build of a 1280x800 LVGL firmware wants four to eight. So
 * the build happens on a developer machine, and this panel's job is to hand over
 * the exact command, accept the result, and flash it.
 *
 * WHICH MAKES THE TIMING A FEATURE. The build starts when the screen is created,
 * not when you click flash: name it, go and get it off the shelf, plug it in, and
 * by the time you are back the binary is waiting. A slow compile costs nothing
 * here because nothing is waiting on it.
 *
 * THE SETUP CODE IS SHOWN ONCE, ON PURPOSE. It is compiled into the firmware, so
 * anyone who has seen it could claim that screen — which is why it appears in a
 * panel the operator dismisses, rather than in a toast or a field they might
 * screenshot onto a projector.
 */
type ScreenRow = {
  id: string;
  name: string;
  model: string;
  status: string;
  hasFirmware: boolean;
  firmwareVer: string | null;
  lastSeenAt: string | null;
  settingsRev: number;
  appliedRev: number | null;
  orientation: string;
  themeMode: string;
  idleMode: string;
  skipEnabled: boolean;
  timezone: string;
  createdBy: string | null;
  uploadedBy: string | null;
};

const STATUS_TONE: Record<string, string> = {
  active: "#4e9fd4",
  offline: "#6a8ba8",
  building: "#c8a76a",
  claimed: "#c8a76a",
  revoked: "#b4432f",
};

export default function ScreensPanel({ hidden }: { hidden: boolean }) {
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The command for a screen that has just been created. Dismissed on purpose and
  // never re-fetched: the token inside it is shown once and then forgotten.
  const [command, setCommand] = useState<{ label: string; text: string; note: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/devices", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 403 ? "You are not signed in as an operator." : "Could not load the screens.");
      const data = await res.json();
      setRows(data.devices || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load the screens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hidden) void load();
  }, [hidden, load]);

  // Only while this tab is open: a screen heartbeats every sixty seconds and
  // there is no reason to keep asking while somebody is looking at the database.
  useEffect(() => {
    if (hidden) return;
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [hidden, load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Screen" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not add that screen.");
      setCommand({
        label: name.trim() || "Screen",
        text: data.buildCommand,
        note: `Setup codes expire ${new Date(data.claimExpiresAt).toLocaleString()}. Build it before then, and upload the result below.`,
      });
      setName("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not add that screen.");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "That did not work.");
      if (data.buildCommand) {
        setCommand({ label: rows.find((r) => r.id === id)?.name ?? "Screen", text: data.buildCommand, note: data.note ?? "" });
      }
      await load();
    } catch (e: any) {
      setError(e?.message || "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove ${label}? Its firmware file is deleted too.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/admin/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File, id: string) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("firmware", file);
      const res = await fetch(`/api/admin/devices/${encodeURIComponent(id)}/firmware`, { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "That file could not be used.");
      await load();
    } catch (e: any) {
      setError(e?.message || "That file could not be used.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function flash(id: string) {
    // WebSerial, checked ourselves rather than guessed at from the user agent:
    // it has spread beyond Chromium, so a hardcoded "Firefox cannot do this"
    // would be wrong about a browser that now can.
    if (!("serial" in navigator) || !window.isSecureContext) {
      setError(
        window.isSecureContext
          ? "Flashing needs a browser that can talk to the screen over USB — Chrome, Edge or Firefox."
          : "The browser will only flash from a secure (https) address.",
      );
      return;
    }
    try {
      const res = await fetch(`/api/admin/devices/manifest?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const manifest = await res.json();
      if (!res.ok) throw new Error(manifest?.error || "That screen is not ready to flash.");

      // The flasher is loaded from a CDN AT RUNTIME, not bundled, and that is the
      // library's intended usage rather than a shortcut: esp-web-tools imports
      // deep @material/web internals that only resolve when the browser fetches
      // them, so bundling it fails the production build with 15 unresolvable
      // modules. It is only needed by somebody about to plug a cable into a
      // screen, so the network cost is paid at exactly that moment and never on
      // a normal page load.
      await loadFlasher();

      const holder = document.createElement("div");
      holder.id = `flash-holder-${id}`;
      document.body.appendChild(holder);
      const button = document.createElement("esp-web-install-button") as any;
      // The manifest is passed as the object rather than a URL: the binary sits
      // behind a signed ten-minute link, and handing the tool a path would have
      // it re-fetch something already authorised.
      button.manifest = manifest;
      holder.appendChild(button);
    } catch (e: any) {
      setError(e?.message || "Could not start the flash.");
    }
  }

  /** Loaded once per session, and only ever when somebody is about to flash. */
  let flasherLoaded: Promise<void> | null = null;
  function loadFlasher(): Promise<void> {
    if (flasherLoaded) return flasherLoaded;
    flasherLoaded = (async () => {
      const url = "https://unpkg.com/esp-web-tools@10/dist/web/install-button.js";
      // A variable specifier, so the bundler leaves it alone rather than trying
      // to resolve a URL at build time.
      await import(/* @vite-ignore */ /* webpackIgnore: true */ url);
    })();
    return flasherLoaded;
  }

  return (
    <section className="card" id="section-screens" style={hidden ? { display: "none" } : undefined}>
      <h2>Screens</h2>
      <p style={{ color: "var(--color-muted)", fontSize: "0.9rem", marginTop: "-0.25rem" }}>
        Wall displays that show what is playing. They are not listeners: a screen never signs in, and it
        never appears in the signed-in or listening counts.
      </p>

      <form onSubmit={add} style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="screen-name" className="admin-label">Screen name</label>
          <input
            id="screen-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen, Studio, Hallway"
            style={{ width: "100%", padding: "0.75rem 1rem", fontSize: "1rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)" }}
          />
        </div>
        <button id="btn-add-screen" className="primary-btn" type="submit" disabled={busy} style={{ padding: "0.75rem 1.5rem", fontSize: "1rem", whiteSpace: "nowrap" }}>Add screen</button>
      </form>

      {error && (
        <p id="screens-error" style={{ color: "#ff4d4d", fontSize: "0.9rem", marginTop: "1rem" }}>{error}</p>
      )}

      {command && (
        <div id="build-command" style={{ marginTop: "1.25rem", padding: "1rem", border: "1px solid var(--color-accent-warm)", borderRadius: "8px" }}>
          <h3 style={{ marginTop: 0 }}>Build {command.label}</h3>
          <p style={{ color: "var(--color-muted)", fontSize: "0.875rem" }}>{command.note}</p>
          <pre style={{ background: "var(--color-bg)", padding: "0.75rem", borderRadius: "6px", overflowX: "auto", fontSize: "0.8rem" }}>{command.text}</pre>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
            <button id="btn-copy-build" className="primary-btn" type="button" onClick={async () => {
              await navigator.clipboard.writeText(command.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>{copied ? "Copied" : "Copy the command"}</button>
            <button id="btn-dismiss-build" className="primary-btn" type="button" onClick={() => setCommand(null)}>Done</button>
          </div>
        </div>
      )}

      <div id="screens-list" style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {loading && rows.length === 0 && <p style={{ color: "var(--color-muted)" }}>Loading…</p>}
        {!loading && rows.length === 0 && !command && (
          <p style={{ color: "var(--color-muted)" }}>No screens yet.</p>
        )}
        {rows.map((r) => {
          const stale = r.lastSeenAt ? Date.now() - new Date(r.lastSeenAt).getTime() > 90_000 : false;
          const live = r.status === "active" && !stale;
          return (
            <div key={r.id} id={`screen-${r.id}`} style={{ border: "1px solid var(--color-border)", borderRadius: "8px", padding: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <div>
                  <strong style={{ fontSize: "1rem" }}>{r.name}</strong>
                  <span style={{ marginLeft: "0.75rem", color: STATUS_TONE[r.status] ?? "var(--color-muted)", fontSize: "0.85rem" }}>
                    {live ? "● Active" : r.status === "building" && !r.hasFirmware ? "Waiting for firmware" : r.status === "revoked" ? "Revoked" : stale ? "Not seen recently" : r.status}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {!r.hasFirmware && (
                    <button id={`btn-build-${r.id}`} className="primary-btn" type="button" disabled={busy}
                      onClick={() => act(r.id, "newClaim")}>Build it</button>
                  )}
                  {r.hasFirmware && (
                    <button id={`btn-flash-${r.id}`} className="primary-btn" type="button" disabled={busy}
                      onClick={() => flash(r.id)}>Flash</button>
                  )}
                  <label className="primary-btn" style={{ cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
                    Upload firmware
                    <input ref={fileRef} type="file" accept=".bin" style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f, r.id); uploadFor.current = r.id; }} />
                  </label>
                  <button id={`btn-rotate-${r.id}`} className="primary-btn" type="button" disabled={busy}
                    onClick={() => act(r.id, "rotateCredentials")}>Reset credentials</button>
                  <button id={`btn-remove-${r.id}`} className="primary-btn" type="button" disabled={busy}
                    onClick={() => remove(r.id, r.name)}>Remove</button>
                </div>
              </div>
              <dl className="db-ledger" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
                <div><dt>Model</dt><dd>{r.model}</dd></div>
                <div><dt>Firmware</dt><dd>{r.firmwareVer ?? "not reported yet"}</dd></div>
                <div><dt>Last seen</dt><dd>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "never"}</dd></div>
                <div><dt>Orientation</dt><dd>{r.orientation}</dd></div>
                <div><dt>Theme</dt><dd>{r.themeMode}</dd></div>
                <div><dt>When idle</dt><dd>{r.idleMode}</dd></div>
                <div><dt>Skip</dt><dd>{r.skipEnabled ? "allowed" : "hidden"}</dd></div>
                <div><dt>Timezone</dt><dd>{r.timezone || "not set"}</dd></div>
                <div><dt>Settings</dt><dd>
                  rev {r.settingsRev}
                  {r.appliedRev != null && r.appliedRev !== r.settingsRev && (
                    <span style={{ color: "var(--color-accent-warm)" }}> — the screen has applied {r.appliedRev}, and will pick up the rest</span>
                  )}
                </dd></div>
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}