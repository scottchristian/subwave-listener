"use client";

// The root problem, and the two ways out of it.
//
// WHY THIS IS WORTH A WHOLE SCREEN. Running as root is the biggest thing wrong
// with a default deployment, and the reason is unusually specific: this setup
// wizard is an UNAUTHENTICATED web page until setup finishes. On a root install,
// anything this page can be talked into is done with root — including, on a
// station somebody else could reach, creating a user and handing over.
//
// WHICH IS WHY THE OFFER IS IN HERE. A warning with no exit is a note in the
// logs. Either this page does the handover, or it prints the exact commands and
// says to come back — and the second is a first-class option, not a fallback.

import { useCallback, useEffect, useState } from "react";

type Plan = {
  canAutomate: boolean;
  reason?: string;
  steps: string[];
  manual: string[];
  revert: string[];
  runningAsRoot: boolean;
};

export function RootNotice({ onHandover }: { onHandover: (p: Plan) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    error?: string;
    output?: string[];
    notes?: string[];
    handoverStarted?: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/unprivileged", { cache: "no-store" });
      if (res.status === 404) return;
      setPlan(await res.json());
    } catch {
      /* the app is probably restarting */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!plan || !plan.runningAsRoot) return null;

  const apply = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/setup/unprivileged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "apply" }),
      });
      const d = await res.json();
      if (!res.ok) {
        setResult({ ok: false, error: d.error || "The handover failed." });
        return;
      }
      setResult({ ok: true, output: d.output, notes: d.notes, handoverStarted: d.handoverStarted });
    } catch {
      setResult({
        ok: false,
        error:
          "Lost the connection — which usually means the handover started and this process was replaced. Give it a few seconds, then reload this page.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (result?.ok) {
    return (
      <section className="notice good" id="root-notice">
        <h3>Fixed — you are not running as root any more</h3>
        <ul className="ticklist">
          {(result.output || []).map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
        {(result.notes || []).map((n) => (
          <p className="muted small" key={n}>
            {n}
          </p>
        ))}
        {result.handoverStarted ? (
          <p className="muted">
            The application restarted, so this page reloaded itself. If you can still see
            this message, the handover is done — carry on.
          </p>
        ) : (
          <p className="muted">
            The account and permissions are set. The application is still running as root
            until you restart it with the commands below.
          </p>
        )}
        <button className="btn" onClick={() => onHandover(plan)}>
          Show me the commands
        </button>
      </section>
    );
  }

  return (
    <section className="notice bad" id="root-notice">
      <h3>This one is naughty: you are running as root</h3>
      <p>
        Root can read and change every file on this machine. It works — plenty of
        software ships this way — but here it is worse than usual, because{" "}
        <strong>this setup page is not signed in to.</strong> Until you finish setup it
        is open to anyone who finds the address, and on a root install anything it can be
        asked to do is done as root.
      </p>
      <p className="muted">
        It is a few minutes to fix, and everything below can be undone. Carry on setting
        up first if you would rather — this is not blocking.
      </p>

      {result?.error ? <p className="errline">{result.error}</p> : null}

      <h4>What will happen</h4>
      <ul className="plainlist">
        {plan.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>

      <div className="choice-actions">
        {plan.canAutomate ? (
          <button className="btn primary" disabled={busy} onClick={apply}>
            {busy ? "Setting it up…" : "Set it up for me"}
          </button>
        ) : null}
        <button className="btn" onClick={() => onHandover(plan)}>
          I&apos;ll do it myself — show me the commands
        </button>
      </div>

      {!plan.canAutomate && plan.reason ? (
        <p className="muted small">{plan.reason}</p>
      ) : null}
    </section>
  );
}

export function HandoverCommands({
  plan,
  onDismiss,
}: {
  plan: Plan;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState("");
  const copy = async (text: string, label: string) => {
    await navigator.clipboard?.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <section className="notice warn" id="handover-commands">
      <h3>Move the application to its own account</h3>
      <p>
        Run these as <strong>root</strong>, on the server. They can be run in any order,
        and the whole set can be undone with the commands at the bottom.
      </p>

      <h4>Do this</h4>
      <CodeBlock lines={plan.manual} onCopy={copy} copied={copied} />

      <p>
        Then restart the application as that account, and come back to{" "}
        <a href="/setup">this page</a> — setup carries on exactly where you left it.
      </p>

      <h4>If you change your mind</h4>
      <CodeBlock lines={plan.revert} onCopy={copy} copied={copied} />

      <div className="choice-actions">
        <button className="btn" onClick={onDismiss}>
          Hide this
        </button>
      </div>
    </section>
  );
}

function CodeBlock({
  lines,
  onCopy,
  copied,
}: {
  lines: string[];
  onCopy: (t: string, label: string) => void;
  copied: string;
}) {
  const text = lines.join("\n");
  return (
    <div className="codeblock">
      <pre>{text}</pre>
      <button className="btn small" onClick={() => onCopy(text, "copy")}>
        {copied === "copy" ? "Copied" : "Copy all"}
      </button>
    </div>
  );
}
