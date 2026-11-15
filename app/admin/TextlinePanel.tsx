"use client";

import { useEffect, useState } from "react";
import CollapsibleSection from "./CollapsibleSection";

/**
 * The Linq text line: the station's iMessage/SMS number.
 *
 * SETUP IS LINQ'S, NOT OURS. Signup happens on the operator's own computer with
 * the Linq CLI — nothing here creates an account. This panel takes the two
 * credentials that signup and a webhook subscription produce, and the card
 * says so, because an operator who expects an account form here will look for
 * one and conclude the feature is broken.
 *
 * The values are credentials, so they are write-only: the API reports whether
 * each is set, never the value, and a non-blank field means "replace". A blank
 * save keeps what is stored — pasting a new key is how a bad one is replaced.
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
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setMsg("");
    const prev = status;
    setStatus((s) => (s ? { ...s, enabled: on } : s));
    try {
      const res = await fetch("/api/admin/textline/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: on,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
          ...(secret.trim() ? { webhookSecret: secret.trim() } : {}),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "could not save");
      setStatus(d);
      setKey("");
      setSecret("");
      setMsg("Saved.");
    } catch (e) {
      setStatus(prev);
      setMsg(`Could not save: ${(e as Error)?.message || "unknown error"}`);
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!status?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(status.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg("Couldn't copy — select the URL and copy it by hand.");
    }
  };

  const keyReady = !!key.trim() || !!status?.apiKeySet;
  const secretReady = !!secret.trim() || !!status?.secretSet;

  return (
    <CollapsibleSection
      id="section-textline-settings"
      title={<>Text Line</>}
      summary={<>The station&rsquo;s iMessage/SMS number for listener requests and show reminders, via Linq. Sign up at linqapp.com on your own computer, then paste the two keys here.</>}
      hidden={hidden}
    >
      <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div style={{ fontSize: "0.85rem", color: "var(--color-muted)", lineHeight: 1.5, maxWidth: "560px" }}>
          Nothing on this page creates a Linq account. Install the Linq CLI on your own
          computer, run <code>linq signup</code> once, and it provisions the number and mints
          an API key. Then add a webhook in Linq for <code>message.received</code> pointing at
          the URL below. Paste the API key and the webhook&rsquo;s signing secret here — or
          put <code>LINQ_ENABLED</code>, <code>LINQ_API_KEY</code> and{" "}
          <code>LINQ_WEBHOOK_SECRET</code> in the server&rsquo;s .env.local yourself.
        </div>
        <label className="check" style={{ fontSize: "0.9rem", fontWeight: 600 }}>
          <input
            id="input-textline-enabled"
            type="checkbox"
            checked={on}
            disabled={!keyReady || !secretReady}
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
          <label style={{ fontSize: "0.8rem", color: "var(--color-muted)", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            Webhook signing secret
            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <input
                id="input-textline-secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={status?.secretSet ? "set — enter a new one to replace" : "whsec_…"}
                autoComplete="new-password"
                style={{ width: "280px", padding: "0.5rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", fontFamily: "inherit" }}
              />
              {status?.secretSet ? (
                <span style={{ color: "#34d399", fontSize: "0.8rem", fontWeight: 600, whiteSpace: "nowrap" }}>✓ saved</span>
              ) : null}
            </span>
          </label>
          <button
            id="btn-textline-save"
            className="primary-btn"
            style={{ width: "auto", padding: "0.55rem 1.1rem" }}
            disabled={busy}
            onClick={save}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Webhook URL</span>
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
          Linq&rsquo;s free Shared Line is inbound-first: a number has to text the station before
          the station can text it a code or a reminder. A paid line removes that restriction.
        </div>
        <div id="textline-status" style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>
          {status ? (
            status.enabled
              ? <>On — listeners can link a phone, text requests, and get show reminders.</>
              : status.apiKeySet && status.secretSet
                ? "Keys saved, text line off — tick the box and save to switch it on."
                : "Not configured — paste the API key and signing secret to begin."
          ) : "Loading…"}
        </div>
        {msg ? (
          <div id="textline-msg" style={{ fontSize: "0.875rem", color: "var(--color-accent)" }}>
            {msg}
          </div>
        ) : null}
      </div>
    </CollapsibleSection>
  );
}
