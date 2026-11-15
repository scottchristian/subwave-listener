"use client";

import { useEffect, useState } from "react";
import CollapsibleSection from "./CollapsibleSection";

/**
 * The Linq text line: the station's iMessage/SMS number.
 *
 * SETUP IS LINQ'S, NOT OURS. Signup happens on the operator's own computer with
 * the Linq CLI — nothing here creates an account. The panel takes the API key
 * that signup prints, then creates the webhook subscription itself because Linq
 * returns the signing secret exactly once: making the operator run another CLI
 * command and copy `whsec_…` by hand is the step that goes wrong.
 *
 * The API key is a credential, so it is write-only: the API reports whether it
 * is set, never the value, and a non-blank field means "replace". A blank save
 * keeps what is stored — pasting a new key is how a bad one is replaced.
 */

type Status = {
  enabled: boolean;
  apiKeySet: boolean;
  secretSet: boolean;
  webhookUrl: string;
};

export default function TextlinePanel({ hidden }: { hidden?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [on, setOn] = useState(false);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "setup" | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/textline/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setStatus(d);
        setOn(d.enabled === true);
      })
      .catch(() => {
        // a station mid-restart answers nothing — the next open gets it
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setBusy("save");
    setMsg(null);
    const prev = status;
    setStatus((s) => (s ? { ...s, enabled: on } : s));
    try {
      const res = await fetch("/api/admin/textline/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: on,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "could not save");
      setStatus(d);
      setKey("");
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e) {
      setStatus(prev);
      setMsg({ kind: "error", text: `Could not save: ${(e as Error)?.message || "unknown error"}` });
    } finally {
      setBusy(null);
    }
  };

  const setupWebhook = async () => {
    setBusy("setup");
    setMsg(null);
    try {
      const res = await fetch("/api/admin/textline/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setup",
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "could not set up the webhook");
      setStatus(d);
      setKey("");
      setMsg({ kind: "ok", text: "Webhook set up — the signing secret is saved and Linq will deliver inbound texts here." });
    } catch (e) {
      setMsg({ kind: "error", text: `Could not set up the webhook: ${(e as Error)?.message || "unknown error"}` });
    } finally {
      setBusy(null);
    }
  };

  const copyUrl = async () => {
    if (!status?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(status.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg({ kind: "error", text: "Couldn't copy — select the URL and copy it by hand." });
    }
  };

  const keyReady = !!key.trim() || !!status?.apiKeySet;
  const ready = keyReady && !!status?.secretSet;
  // A save that changes nothing would still rewrite the env file, so the
  // button stays off until the switch or the key differs.
  const dirty = !!status && (on !== status.enabled || key.trim() !== "");

  return (
    <CollapsibleSection
      id="section-textline-settings"
      title={<>Text Line</>}
      summary={<>The station&rsquo;s iMessage/SMS number for listener requests and show reminders, via Linq. Sign up on your own computer, paste the API key, and the panel connects the webhook.</>}
      hidden={hidden}
    >
      <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ fontSize: "0.85rem", color: "var(--color-muted)", lineHeight: 1.5, maxWidth: "600px" }}>
          Linq (<a href="https://linqapp.com" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)" }}>linqapp.com</a>)
          provides the number and the messaging API — read about it there before you start.
          Nothing on this page creates a Linq account. Install the{" "}
          <a href="https://github.com/linq-team/linq-cli" target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)" }}>Linq CLI</a>{" "}
          on your own computer and run <code>linq signup</code> once — it provisions the number and
          prints an API key. Paste that key here and press <strong>Set up webhook</strong>:
          the app registers this station&rsquo;s address with Linq for inbound texts and
          stores the signing secret, which Linq only ever shows once. A webhook already
          pointing at this address is replaced so a fresh secret can be stored. The
          address must be HTTPS.
        </div>
        <label className="check" style={{ fontSize: "0.9rem", fontWeight: 600 }}>
          <input
            id="input-textline-enabled"
            type="checkbox"
            checked={on}
            disabled={!ready}
            onChange={(e) => setOn(e.target.checked)}
          />
          Turn on the text line
        </label>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.75rem", flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.8rem", color: "var(--color-muted)", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            API key
            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input
                id="input-textline-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={status?.apiKeySet ? "set — enter a new one to replace" : "linq_…"}
                autoComplete="new-password"
                style={{ width: "280px", padding: "0.5rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", fontFamily: "inherit" }}
              />
              {status?.apiKeySet ? (
                <span style={{ color: "#34d399", fontSize: "0.8rem", fontWeight: 600, whiteSpace: "nowrap" }}>✓ saved</span>
              ) : null}
            </span>
          </label>
          <button
            id="btn-textline-setup-webhook"
            className="primary-btn"
            style={{ width: "auto", padding: "0.55rem 1.1rem" }}
            disabled={busy !== null || !keyReady || !status?.webhookUrl}
            onClick={setupWebhook}
          >
            {busy === "setup" ? "Setting up…" : "Set up webhook"}
          </button>
          <button
            id="btn-textline-save"
            className="primary-btn"
            style={{ width: "auto", padding: "0.55rem 1.1rem", background: "rgba(255,255,255,0.1)", color: "#fff" }}
            disabled={busy !== null || !dirty}
            onClick={save}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
        {msg ? (
          <div
            id="textline-msg"
            role={msg.kind === "error" ? "alert" : "status"}
            style={{ fontSize: "0.875rem", color: msg.kind === "error" ? "#ff6b6b" : "var(--color-accent)" }}
          >
            {msg.text}
          </div>
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Webhook URL</span>
          <span id="textline-webhook-state" style={{ fontSize: "0.8rem", fontWeight: 600, color: status?.secretSet ? "#34d399" : "var(--color-muted)" }}>
            {status?.secretSet ? "✓ connected" : "not set up"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            id="input-textline-webhook-url"
            type="text"
            readOnly
            value={status?.webhookUrl || ""}
            placeholder="set NEXTAUTH_URL to show this"
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: "340px", maxWidth: "100%", padding: "0.5rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "rgba(255,255,255,0.03)", color: "var(--color-text)", fontFamily: "monospace", fontSize: "0.8rem" }}
          />
          <button
            id="btn-textline-copy-webhook"
            className="primary-btn"
            style={{ width: "auto", padding: "0.5rem 0.9rem", background: "rgba(255,255,255,0.1)", color: "#fff" }}
            disabled={!status?.webhookUrl}
            onClick={copyUrl}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div style={{ fontSize: "0.8rem", color: "var(--color-muted)", lineHeight: 1.5 }}>
          Linq&rsquo;s free Shared Line is limited: it only messages numbers on its contact list
          (up to 20, added in Linq with <code>linq contacts add +61…</code>), and a number has
          to text the station before the station can text it a code or a reminder. A paid
          dedicated line removes both limits.
        </div>
        <div id="textline-status" style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>
          {status ? (
            status.enabled
              ? <>On — listeners can link a phone, text requests, and get show reminders.</>
              : !status.apiKeySet
                ? "Not configured — paste your Linq API key to begin."
                : !status.secretSet
                  ? "API key saved — press Set up webhook to connect Linq to this station."
                  : "Ready, text line off — tick the box and save to switch it on."
          ) : "Loading…"}
        </div>
      </div>
    </CollapsibleSection>
  );
}
