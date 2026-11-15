"use client";

import { useCallback, useEffect, useState } from "react";
import { STATION } from "@/lib/station";
import { formatPhoneInput } from "@/lib/phone";
import { COUNTRIES, isoForDial, type Country } from "@/lib/countries";

export type PhoneView = {
  available: boolean;
  linked: boolean;
  phone: string | null;
  optedOut: boolean;
  showIds: string[];
  codeSentAt: string | null;
  pendingPhone?: string | null;
  messages: { id: string; direction: string; body: string; createdAt: string }[];
  defaultCountry?: string;
};

type Step = "number" | "code" | "manage";

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
};

/** E.164 in the shape the listener typed it: +61 408 344 123. */
const fmtPhone = (phone: string, cc?: string) => {
  const code = cc && phone.startsWith(cc) ? cc : "";
  const rest = code ? phone.slice(code.length) : "";
  if (rest.length < 9) return phone;
  const head = rest.slice(0, rest.length - 6);
  return [code, head, rest.slice(-6, -3), rest.slice(-3)].filter(Boolean).join(" ");
};

/**
 * Link a phone, then live with it: the code flow only advances after a send
 * the server confirmed, and the manage view puts Unlink ABOVE the thread —
 * removing the number is the primary action on that screen, not a footnote.
 */
export default function PhonePanel({
  initial,
  onChanged,
  onClose,
}: {
  initial: PhoneView | null;
  onChanged: (view: PhoneView) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<PhoneView | null>(initial);
  const [step, setStep] = useState<Step>(() =>
    initial?.linked ? "manage" : initial?.codeSentAt ? "code" : "number"
  );
  const [number, setNumber] = useState("");
  // Null means "not chosen yet": the station's own country is the default, and
  // switching it re-groups whatever digits are already in the field.
  const [countryPick, setCountryPick] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const dial = countryPick ?? view?.defaultCountry ?? "";
  const iso = countryPick ?? isoForDial(view?.defaultCountry ?? "");

  const apply = useCallback(
    (next: PhoneView) => {
      setView(next);
      setStep(next.linked ? "manage" : next.codeSentAt ? "code" : "number");
      setError("");
      onChanged(next);
    },
    [onChanged]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/phone");
      if (res.status === 401) {
        setError("Sign in to link a phone.");
        return null;
      }
      if (!res.ok) return null;
      const next = (await res.json()) as PhoneView;
      apply(next);
      return next;
    } catch {
      return null;
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
    // One refresh on mount: the panel is the only place that needs the full
    // thread, so it does not add a read to every page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.message || "Something went wrong. Try again.");
        return null;
      }
      return data;
    } catch {
      setError("Couldn't reach the station. Check your connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const getCode = async () => {
    const fresh = await post("/api/phone/start", {
      phone: number,
      ...(countryPick ? { country: countryPick } : {}),
    });
    if (!fresh) return;
    setSentTo(number.trim());    setCode("");
    await refresh();
    setStep("code");
  };

  const verify = async () => {
    const fresh = await post("/api/phone/verify", { code });
    if (!fresh) return;
    await refresh();
    setStep("manage");
  };

  const unlink = async () => {
    const fresh = await post("/api/phone/unlink", {});
    if (!fresh) return;
    setConfirming(false);
    setNumber("");
    setSentTo("");
    setCode("");
    await refresh();
    setStep("number");
  };

  const shell = (body: React.ReactNode) => (
    <div
      id="phone-overlay-card"
      onClick={(e) => e.stopPropagation()}
      className="overlay-card-enter"
      style={{ maxWidth: "520px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}
    >
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Your phone</h2>
          <button
            id="btn-close-phone"
            onClick={onClose}
            className="primary-btn"
            style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}
          >
            Close
          </button>
        </div>
        {body}
      </div>
    </div>
  );

  const errorLine = error ? (
    <p role="alert" style={{ color: "#ff6b6b", fontSize: "0.875rem", margin: "0 0 0.75rem" }}>
      {error}
    </p>
  ) : null;

  if (!view) {
    return shell(
      <>
        {errorLine}
        {!error && <p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>Loading…</p>}
      </>
    );
  }

  if (!view.available && !view.linked) {
    return shell(
      <p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>
        The station&apos;s text line isn&apos;t switched on yet — check back soon.
      </p>
    );
  }

  if (step === "manage") {
    return shell(
      <>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.75rem", borderRadius: "10px", background: "rgba(255,255,255,0.05)", marginBottom: "0.75rem" }}>
          <div>
            <div style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>Linked number</div>
            <div id="phone-linked-number" style={{ fontSize: "1.05rem", fontWeight: 700 }}>{fmtPhone(view.phone ?? "", view.defaultCountry)}</div>
          </div>
          <span style={{ color: "#34d399", fontSize: "0.8rem", fontWeight: 600, whiteSpace: "nowrap" }}>✓ linked</span>
        </div>

        {view.optedOut && (
          <p style={{ fontSize: "0.85rem", color: "#fbbf24", margin: "0 0 0.75rem" }}>
            You replied STOP. Turn a show reminder back on in Shows to start alerts again.
          </p>
        )}

        {/* Above the thread: removing the number is the action this screen
            exists for, and its consequence is everything below it. */}
        {!confirming ? (
          <button
            id="btn-unlink-phone"
            onClick={() => setConfirming(true)}
            style={{ display: "block", width: "100%", padding: "0.65rem 1rem", borderRadius: "8px", border: "1px solid rgba(255,77,77,0.5)", background: "rgba(255,77,77,0.1)", color: "#ff6b6b", fontSize: "0.9rem", fontWeight: 600, cursor: "pointer", marginBottom: "1rem" }}
          >
            Unlink phone
          </button>
        ) : (
          <div id="phone-unlink-confirm" style={{ padding: "0.75rem", borderRadius: "8px", border: "1px solid rgba(255,77,77,0.5)", background: "rgba(255,77,77,0.08)", marginBottom: "1rem" }}>
            <p style={{ fontSize: "0.875rem", margin: "0 0 0.75rem", lineHeight: 1.45 }}>
              Remove your number from {STATION.name}? You&apos;ll stop receiving show alerts, and your entire text
              history is permanently deleted. Requests won&apos;t work until you link again.
            </p>
            {errorLine}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                id="btn-unlink-phone-confirm"
                onClick={unlink}
                disabled={busy}
                className="primary-btn"
                style={{ width: "auto", padding: "0.5rem 0.9rem", fontSize: "0.85rem", background: "#b91c1c" }}
              >
                {busy ? "Removing…" : "Yes, unlink phone"}
              </button>
              <button
                id="btn-unlink-phone-cancel"
                onClick={() => { setConfirming(false); setError(""); }}
                style={{ padding: "0.5rem 0.9rem", fontSize: "0.85rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text)", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Recent texts</h3>
        {view.messages.length === 0 ? (
          <p style={{ fontSize: "0.9rem", color: "var(--color-muted)", marginBottom: 0 }}>
            No texts yet. Try sending one — requests and shout-outs land here.
          </p>
        ) : (
          <div id="phone-thread" style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "46vh", overflowY: "auto", paddingRight: "0.25rem" }}>
            {view.messages.map((m) => {
              const out = m.direction === "out";
              return (
                <div key={m.id} style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                  <div
                    style={{
                      padding: "0.5rem 0.7rem",
                      borderRadius: "12px",
                      fontSize: "0.9rem",
                      lineHeight: 1.4,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      background: out ? "rgba(78,159,212,0.22)" : "rgba(255,255,255,0.07)",
                      border: out ? "1px solid rgba(78,159,212,0.4)" : "1px solid transparent",
                    }}
                  >
                    {m.body}
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--color-muted)", marginTop: "0.15rem", textAlign: out ? "right" : "left" }}>
                    {out ? "Station" : "You"} · {fmtTime(m.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  if (step === "code") {
    return shell(
      <>
        <p style={{ fontSize: "0.95rem", lineHeight: 1.5, margin: "0 0 1rem" }}>
          Enter the 6-digit code we sent to <strong>{sentTo || fmtPhone(view.pendingPhone ?? "", view.defaultCountry) || "your phone"}</strong>.
        </p>
        {errorLine}
        <label htmlFor="input-phone-code" style={{ display: "block", fontSize: "0.85rem", color: "var(--color-muted)", marginBottom: "0.35rem" }}>
          Code
        </label>
        <input
          id="input-phone-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          autoFocus
          className="input-field"
          style={{ marginBottom: "1rem", letterSpacing: "0.35em", fontSize: "1.2rem", textAlign: "center" }}
        />
        <button
          id="btn-verify-phone"
          onClick={verify}
          disabled={busy || code.length !== 6}
          className="primary-btn"
          style={{ width: "100%", marginBottom: "0.5rem", opacity: busy || code.length !== 6 ? 0.6 : 1 }}
        >
          {busy ? "Checking…" : "Verify"}
        </button>
        <button
          id="btn-phone-different-number"
          onClick={() => { setStep("number"); setError(""); setCode(""); }}
          style={{ display: "block", width: "100%", padding: "0.5rem", background: "none", border: "none", color: "var(--color-muted)", fontSize: "0.85rem", cursor: "pointer" }}
        >
          Use a different number
        </button>
      </>
    );
  }

  // Countries sharing the station's dial code come first: a listener abroad
  // still gets the station's own country at the top, then everything else.
  const sameDial = dial ? COUNTRIES.filter((c) => c.dial === dial) : [];
  const otherDial = COUNTRIES.filter((c) => !sameDial.includes(c));
  const optionLabel = (c: Country) => `${c.flag} ${c.name} (${c.dial})`.trim();

  return shell(
    <>
      <p style={{ fontSize: "0.95rem", lineHeight: 1.5, margin: "0 0 1rem" }}>
        Link your phone to get show reminders by text, and to text the station requests and shout-outs.
      </p>
      {errorLine}
      <label htmlFor="select-phone-country" style={{ display: "block", fontSize: "0.85rem", color: "var(--color-muted)", marginBottom: "0.35rem" }}>
        Country
      </label>
      <select
        id="select-phone-country"
        value={countryPick ?? ""}
        onChange={(e) => {
          const next = e.target.value || null;
          setCountryPick(next);
          setNumber((n) => formatPhoneInput(n, next ?? isoForDial(view.defaultCountry || "")));
        }}
        className="input-field"
        style={{ marginBottom: "0.75rem" }}
      >
        <option value="">{dial ? `Station's country (${dial})` : "Choose your country"}</option>
        {sameDial.map((c) => (
          <option key={c.code} value={c.code}>{optionLabel(c)}</option>
        ))}
        {otherDial.map((c) => (
          <option key={c.code} value={c.code}>{optionLabel(c)}</option>
        ))}
      </select>
      <label htmlFor="input-phone-number" style={{ display: "block", fontSize: "0.85rem", color: "var(--color-muted)", marginBottom: "0.35rem" }}>
        Mobile number
      </label>
      <input
        id="input-phone-number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={number}
        onChange={(e) => setNumber(formatPhoneInput(e.target.value, iso))}
        placeholder={iso === "AU" ? "0408 344 123" : "Mobile number"}
        className="input-field"
        style={{ marginBottom: "1rem" }}
      />
      <button
        id="btn-get-phone-code"
        onClick={getCode}
        disabled={busy || number.replace(/\D/g, "").length < 6}
        className="primary-btn"
        style={{ width: "100%", marginBottom: "0.6rem", opacity: busy || number.replace(/\D/g, "").length < 6 ? 0.6 : 1 }}
      >
        {busy ? "Sending…" : "Get my code"}
      </button>
      <p style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginBottom: 0, lineHeight: 1.45 }}>
        We&apos;ll text a 6-digit code to confirm it&apos;s yours. Message rates may apply.
      </p>
    </>
  );
}
