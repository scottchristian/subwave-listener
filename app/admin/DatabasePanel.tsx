"use client";

// Admin → Database.
//
// One job: move the station between SQLite and Postgres without losing a row
// or cutting a listener off mid-song.
//
// This used to be five buttons — check, copy, switch, copy back, switch back —
// which made a single irreversible operation look like five independent ones, and
// left the ordering entirely to the operator: the copy could be run twice, the
// switch could be pressed before anything was copied, and nothing in the UI tied
// them together.
//
// It is now one button per direction and one guided flow, in the order the work
// actually has to happen: nobody listening, are you sure, is the target usable,
// copy, prove it is 1:1, switch. Each step is reported as it lands, so the panel
// says what it is doing rather than sitting silent through a long copy.
//
// The buttons are not the only guard. Every gate is re-checked server-side at
// the moment it matters — the cutover route re-reads the listener list and
// re-runs the row-by-row comparison, so a stale page cannot talk it into
// switching.

import { useCallback, useEffect, useRef, useState } from "react";
import ConnectionFields, { buildUrl, parseUrl, EMPTY_FIELDS, type ConnFields } from "./ConnectionFields";
import { drainFrames, type CopyEvent } from "./copy-stream";

type Check = { name: string; ok: boolean; detail: string; fix?: string };
type Probe = {
  role: string | null;
  database: string | null;
  version: string | null;
  ready: boolean;
  checks: Check[];
  sql: string;
  error?: string;
};
type TableRow = { model: string; source: number; target: number; match: boolean };
type KeepAlive = {
  enabled: boolean;
  seconds: number;
  running: boolean;
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  totalPings: number;
  min: number;
  max: number;
};
type Listener = { userId: string; name: string; since: string };
type Status = {
  provider: "sqlite" | "postgresql";
  target: "sqlite" | "postgresql";
  currentUrl: string;
  counts: Record<string, number>;
  totalRows: number;
  liveError: string | null;
  /** Null means "could not read the listener list" — treated as not-empty. */
  listeners: Listener[] | null;
  listenerCount: number | null;
  suggestedSqliteFile: string;
};

/** The move flow, in the order the work has to happen. */
type MoveStep =
  | "idle"
  | "confirm"
  | "target"
  | "checking"
  | "copying"
  | "verifying"
  | "switching"
  | "done"
  | "failed";

type MoveState = { to: "postgresql" | "sqlite" } | null;

const LEDGER: [string, string][] = [
  ["users", "Users"],
  ["streams", "Stream sessions"],
  ["requests", "Requests"],
  ["likes", "Likes"],
  ["donations", "Donations"],
  ["settings", "Settings"],
  ["sessions", "Auth sessions"],
];

export default function DatabasePanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  // The connection is held twice, as a string and as fields, kept in step by
  // whichever one was edited last. See ConnectionFields for why that rule.
  const [url, setUrl] = useState("");
  const [fields, setFields] = useState<ConnFields>(EMPTY_FIELDS);
  const [urlError, setUrlError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  // The move flow's own state. `move` is which direction is in flight, `moveStep`
  // how far it got. There are no separate copying/switching/verified flags any
  // more — one step cannot disagree with another.
  const [move, setMove] = useState<MoveState>(null);
  const [moveStep, setMoveStep] = useState<MoveStep>("idle");
  const [moveError, setMoveError] = useState("");
  const [moveProgress, setMoveProgress] = useState<string[]>([]);
  const [moveProgressText, setMoveProgressText] = useState("");
  const [moveTables, setMoveTables] = useState<TableRow[] | null>(null);
  // Which step the flow died on, so the marker sits next to the explanation
  // rather than always defaulting to the first one.
  const lastFailed = useRef<MoveStep | null>(null);
  // Set once the operator types their own path, so a status refresh stops
  // overwriting a deliberate choice with the suggestion.
  const targetFileTouched = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [targetFile, setTargetFile] = useState("");
  const [ka, setKa] = useState<KeepAlive | null>(null);
  const [kaOn, setKaOn] = useState(false);
  const [kaSeconds, setKaSeconds] = useState("300");
  const [kaBusy, setKaBusy] = useState(false);
  const [kaMsg, setKaMsg] = useState("");
  // Set on any hand edit, cleared on successful save. The 15s status poll
  // must not touch the form while this is set — it used to flip the switch
  // back on under the operator's finger before they reached Save.
  const kaTouched = useRef(false);

  const onPostgres = status?.provider === "postgresql";

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/database");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not read the database state");
      setStatus(d);
      // Seed the suggested revert path once, so the operator never has to invent
      // an absolute path. Overwritten by hand if they type their own.
      if (d?.suggestedSqliteFile && !targetFileTouched.current) {
        setTargetFile(d.suggestedSqliteFile);
      }
      setLoadError("");
    } catch (e: any) {
      setLoadError(e.message || "Could not read the database state");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll the keep-alive status while this tab is open, so "last ping" is live
  // rather than frozen at the moment the panel loaded.
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const r = await fetch("/api/admin/database/keepalive");
        if (!r.ok) return;
        const d = await r.json();
        if (stop) return;
        setKa(d);
        if (!kaTouched.current) {
          setKaOn(d.enabled);
          setKaSeconds(String(d.seconds));
        }
      } catch {}
    };
    pull();
    const id = setInterval(pull, 15000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const saveKeepAlive = async () => {
    setKaBusy(true);
    setKaMsg("");
    try {
      const r = await fetch("/api/admin/database/keepalive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: kaOn, seconds: Number(kaSeconds) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save");
      setKa(d);
      kaTouched.current = false;
      setKaOn(d.enabled);
      setKaSeconds(String(d.seconds));
      setKaMsg(
        d.enabled
          ? `Pinging every ${d.seconds}s. The station pings immediately on restart.`
          : "Off. The database will sleep when idle."
      );
    } catch (e: any) {
      setKaMsg("");
      setError(e.message || "Could not save");
    } finally {
      setKaBusy(false);
    }
  };

  const since = (ms: number | null) => {
    if (!ms) return "never";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };

  // Any change to the connection invalidates a previous probe and copy: they
  // described a different database than the one now described here.
  const invalidate = () => {
      setProbe(null);
      setMoveTables(null);
    };

  const onUrl = (v: string) => {
    setUrl(v);
    invalidate();
    const parsed = parseUrl(v);
    if (parsed.ok) {
      setFields(parsed.fields);
      setUrlError("");
    } else {
      // Keep the typed text exactly as it is, so the cursor is undisturbed.
      setUrlError(parsed.error);
    }
  };

  const onField = (k: keyof ConnFields, v: string) => {
    const next = { ...fields, [k]: v };
    setFields(next);
    setUrl(buildUrl(next));
    setUrlError("");
    invalidate();
  };

  // The probe and copy send the string, whatever route the operator used.
  const connectionValid = parseUrl(url).ok;

  // --- The move flow -----------------------------------------------------
  //
  // One function, run as a sequence, rather than five buttons the operator has
  // to sequence correctly. `moveStep` is the single source of what the panel is
  // doing, so the UI can never show a state the flow did not actually reach.

  const moveStepRef = useRef<MoveStep>("idle");
  // Always go through this. The failure handler runs after a long await chain and
  // has to name the step that broke; if the ref only followed React state it would
  // still be a render behind, and a failure that happens fast (the copy refusing
  // immediately) would be blamed on the step before it.
  const goStep = (step: MoveStep) => {
    moveStepRef.current = step;
    setMoveStep(step);
  };

  /** Open the flow at the confirmation step. */
  const beginMove = (to: "postgresql" | "sqlite") => {
    lastFailed.current = null;
    moveStepRef.current = "confirm";
    setMove({ to });
    goStep("confirm");
    setMoveError("");
    setMoveProgress([]);
    setMoveProgressText("");
    setMoveTables(null);
  };

  const resetMove = () => {
    lastFailed.current = null;
    moveStepRef.current = "idle";
    goStep("idle");
    setMoveError("");
    setMoveProgress([]);
    setMoveProgressText("");
    setMoveTables(null);
    setProbe(null);
  };

  /** Re-read status: listener count for the button state, engine after a move. */
  const refreshStatus = useCallback(async (): Promise<Status | null> => {
    try {
      const r = await fetch("/api/admin/database", { cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      setStatus(d);
      return d as Status;
    } catch {
      return null;
    }
  }, []);

  const setFileSuggestion = useCallback((s: Status | null) => {
    if (s?.suggestedSqliteFile) setTargetFile(s.suggestedSqliteFile);
  }, []);

  /** Step 3 — can we actually use this target? */
  const checkTarget = async (targetUrl: string) => {
    goStep("checking");
    const r = await fetch("/api/admin/database/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: targetUrl }),
    });
    const d = await r.json().catch(() => null);
    // The file probe answers 400 with a full check list on failure, so keep the
    // checks either way — they are the useful part.
    if (d?.checks) setProbe(d as Probe);
    if (!r.ok || !d?.ready) {
      throw new Error(d?.error || "The target is not usable yet.");
    }
  };

  /** Step 4 — copy, streamed in both directions so progress is never silent. */
  const runCopy = async (to: "postgresql" | "sqlite") => {
    goStep("copying");
    setMoveProgressText("Starting…");
    const res = await fetch(
      to === "postgresql" ? "/api/admin/database/copy" : "/api/admin/database/copy-back",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(to === "postgresql" ? { url } : { targetFile }),
      }
    );
    if (!res.ok || !res.body) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d?.error || "The copy failed.");
    }

    // EventSource is GET-only, so the POST response stream is read by hand.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let outcome: Extract<CopyEvent, { kind: "done" | "error" }> | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = drainFrames(buf);
      buf = rest;
      for (const ev of events) {
        if (ev.kind === "status" || ev.kind === "progress") {
          setMoveProgressText(ev.text);
          if (ev.kind === "progress") setMoveProgress((p) => [...p, ev.text]);
        } else {
          outcome = ev;
        }
      }
    }
    if (!outcome) throw new Error("The copy stopped without reporting a result.");
    if (outcome.kind === "error") {
      throw new Error(outcome.message);
    }
    return outcome;
  };

  /** Step 5 — re-read both ends and prove they match, as its own visible step. */
  const runVerify = async (to: "postgresql" | "sqlite") => {
    goStep("verifying");
    const targetUrl = to === "postgresql" ? url : `file:${targetFile}`;
    const r = await fetch("/api/admin/database/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl }),
    });
    const d = await r.json().catch(() => null);
    if (d?.tables) setMoveTables(d.tables as TableRow[]);
    if (!r.ok || !d?.ok) {
      throw new Error(d?.error || "The two databases do not match — not switching.");
    }
    return d as { total: number; tables: TableRow[] };
  };

  /** Steps 1–6. Everything after the confirm is not the operator's decision. */
  const runMove = async (to: "postgresql" | "sqlite") => {
    setMove({ to });
    goStep("checking");
    setMoveError("");
    setMoveProgress([]);
    setMoveProgressText("");
    setMoveTables(null);
    setError("");
    setMessage("");

    try {
      // 1 — the room. The button is disabled while anyone is listening, but that
      // is a rendering; this is the check that actually matters, and the copy
      // routes and the cutover route each enforce it again.
      const fresh = await refreshStatus();
      const busy = fresh ? fresh.listenerCount !== 0 : true;
      if (busy) {
        const who = fresh?.listeners?.map((l) => l.name).join(", ");
        throw new Error(
          fresh?.listenerCount
            ? `${fresh.listenerCount} listener(s) are on air${who ? ` (${who})` : ""}. A move restarts the station and cuts them off mid-song.`
            : "Could not read the listener list, so I cannot prove the room is empty."
        );
      }

      // 3 — is the target usable at all?
      await checkTarget(to === "postgresql" ? url : `file:${targetFile}`);

      // 4 — copy.
      await runCopy(to);

      // 5 — prove 1:1, as a step you can see rather than a flag it set.
      const verified = await runVerify(to);

      // 6 — switch. The route re-checks the room and re-verifies itself before
      // touching anything; this call is the request, not the guarantee.
      goStep("switching");
      setMoveProgressText("Rebuilding and restarting the station…");
      const cut = await fetch("/api/admin/database/cutover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, url: to === "postgresql" ? url : `file:${targetFile}` }),
      });
      const cd = await cut.json().catch(() => null);
      if (!cut.ok) {
        throw new Error(cd?.error || "The switch did not happen.");
      }

      // The process answering this request is about to die, so it can never
      // confirm the outcome. Poll instead: once status answers again, whatever it
      // says is the truth.
      setMoveProgressText("Restarting. Waiting for the station to come back…");
      const deadline = Date.now() + 180_000;
      let back: Status | null = null;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 3000));
        const s = await refreshStatus();
        // An ok response is NOT proof the restart happened. The outgoing process
        // keeps serving for a moment as it dies, and if pm2 failed to restart it
        // outright, the old one answers indefinitely. Accepting the first reply
        // would report "Moved to Postgres" while the station was still on
        // SQLite. Only the new engine counts as done.
        if (s && s.provider === to) { back = s; break; }
      }
      if (!back) {
        throw new Error(
          "The station never came back on the new database. It may still be starting, or the restart may not have " +
            "happened — reopen the Database tab to see which engine is actually live before trying anything else."
        );
      }
      setFileSuggestion(back);
      goStep("done");
      setMessage(
        `Moved to ${to === "postgresql" ? "Postgres" : "SQLite"}. ` +
          `${verified.total.toLocaleString()} rows verified identical before the switch.`
      );
      setMove(null);
    } catch (e: any) {
      lastFailed.current = moveStepRef.current;
      // Leaving the spinner line up makes a dead flow look like it is still
      // working, which is exactly what an operator does not need here.
      setMoveProgressText("");
      goStep("failed");
      setMoveError(e?.message || "The move failed.");
      void refreshStatus();
    }
  };


  if (loadError) {
    return <p style={{ color: "#e06a5c" }}>{loadError}</p>;
  }
  if (!status) {
    return <p style={{ color: "var(--color-muted)" }}>Reading the database state…</p>;
  }

  const failing = probe?.checks.filter((c) => !c.ok) ?? [];
  // A move is only offered into an empty room. listenerCount is null when the
  // list could not be read, which counts as not-empty — the copy routes and the
  // cutover route both fail closed the same way, so the button must not promise
  // something the server would refuse.
  const roomBusy = status.listenerCount === null || status.listenerCount > 0;
  const moveBusy = move !== null && moveStep !== "failed" && moveStep !== "done";
  // Only the button for the direction the station is NOT on is rendered, so
  // neither of these needs to test the current engine: if you can see the
  // button, that direction is available in principle. The remaining reasons to
  // hold off are the same for both — people listening, a move already running,
  // and whatever that direction specifically still needs (a connection, or a
  // destination path).
  const toPgBlocked = roomBusy || moveBusy || !connectionValid;
  const toSqliteBlocked = roomBusy || moveBusy || !targetFile.trim();

  return (
    <>
      <h2>Database</h2>
      <p className="about-text" style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
        The station reads and writes one database at a time. Moving between SQLite and Postgres copies every row and
        checks it before anything switches.
      </p>

      {/* Which engine is live, and what a copy would move. */}
      <div style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div className="db-engine live">
            <span className="db-engine-name">{status.provider === "postgresql" ? "Postgres" : "SQLite"}</span>
            <span className="db-engine-tag">running</span>
          </div>
          <div className="db-engine dormant">
            <span className="db-engine-name">{onPostgres ? "SQLite" : "Postgres"}</span>
            <span className="db-engine-tag">not in use</span>
          </div>
          {status.currentUrl && <div className="db-url">{status.currentUrl}</div>}
        </div>

        <dl className="db-ledger" style={{ marginTop: "1.25rem" }}>
          {LEDGER.filter(([k]) => status.counts[k] !== undefined).map(([k, label]) => (
            <div className="db-ledger-item" key={k}>
              <dt>{label}</dt>
              <dd>{(status.counts[k] as number).toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        {status.liveError && (
          <p style={{ color: "#e06a5c", fontSize: "0.875rem", marginTop: "0.75rem" }}>
            The live database reported an error: {status.liveError}
          </p>
        )}
      </div>

      {/* Free-tier Postgres suspends when idle; the first request afterwards
          pays the cold start. This is a Postgres-only concern. */}
      {onPostgres && (
        <div style={{ marginTop: "2rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <h3 style={{ fontSize: "1rem" }}>Keep the database awake</h3>
            {ka?.running && (
              <span style={{ fontSize: "0.8rem", color: "var(--color-accent)" }}>
                pinging every {ka.seconds}s · last ok {since(ka.lastOkAt)}
              </span>
            )}
          </div>
          <p style={{ color: "var(--color-muted)", fontSize: "0.875rem", marginTop: "0.35rem" }}>
            A free tier sleeps after a while with no traffic, and the next listener pays for the wake-up. This sends one
            cheap <code style={{ color: "var(--color-text)" }}>SELECT 1</code> from the station on a timer. It writes
            nothing, so it costs no WAL and creates no cleanup.
          </p>

          <div className="db-keepalive">
            <div className="db-keepalive-row">
              <span id="db-keepalive-label" className="db-keepalive-label">Ping the database</span>
              <button
                id="db-keepalive-toggle"
                role="switch"
                aria-checked={kaOn}
                aria-labelledby="db-keepalive-label"
                onClick={() => { kaTouched.current = true; setKaOn((o) => !o); }}
                style={{
                  flexShrink: 0, width: "48px", height: "27px", borderRadius: "999px", border: "none", cursor: "pointer",
                  backgroundColor: kaOn ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
                  position: "relative", transition: "background-color 0.2s ease", padding: 0,
                }}
              >
                <span style={{
                  position: "absolute", top: "2px", left: kaOn ? "23px" : "2px", width: "23px", height: "23px",
                  borderRadius: "50%", backgroundColor: "#fff", transition: "left 0.2s ease",
                }} />
              </button>
            </div>

            <div className="db-keepalive-row">
              <label htmlFor="db-keepalive-seconds" className="db-keepalive-label">Every (seconds)</label>
              <input
                id="db-keepalive-seconds"
                className="db-input db-narrow"
                type="number"
                inputMode="numeric"
                min={ka?.min ?? 30}
                max={ka?.max ?? 3600}
                value={kaSeconds}
                disabled={!kaOn}
                onChange={(e) => { kaTouched.current = true; setKaSeconds(e.target.value); }}
              />
              <button
                id="db-keepalive-save"
                className="primary-btn"
                style={{ width: "auto", padding: "0.5rem 1rem" }}
                onClick={saveKeepAlive}
                disabled={kaBusy}
              >
                {kaBusy ? "Saving…" : "Save"}
              </button>
            </div>

            {kaMsg && (
              <p style={{ color: "var(--color-accent)", fontSize: "0.875rem" }}>{kaMsg}</p>
            )}

            {ka && (
              <p style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>
                {ka.totalPings.toLocaleString()} pings since the last restart
                {ka.consecutiveFailures > 0 && ` · ${ka.consecutiveFailures} failing`}
                {ka.lastError && ` · ${ka.lastError}`}
              </p>
            )}
            {ka && !ka.enabled && (
              <p style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>
                Most free tiers suspend after about five minutes idle. 300s is a safe default.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Where the station is going. Only relevant heading to Postgres, and it
          is checked as part of the move rather than by a button of its own. */}
      {!onPostgres && (
        <div style={{ marginTop: "2rem" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.35rem" }}>Postgres connection</h3>
          <p style={{ color: "var(--color-muted)", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
            The role the station will use once it has moved. Nothing is changed by typing it
            here — the permission check runs as step one of the move.
          </p>
          <ConnectionFields
            url={url}
            fields={fields}
            urlError={urlError}
            showPassword={showPassword}
            onUrl={onUrl}
            onField={onField}
            onTogglePassword={() => setShowPassword((v) => !v)}
          />
        </div>
      )}

      {/* ---- Move the station -------------------------------------------
          ONE button, for the direction that is actually available. There used to
          be two — one per direction, with the impossible one disabled — and on a
          station already running Postgres the prominent white pill read "Move to
          Postgres", which is the one thing you cannot do. It was genuinely
          disabled, but a disabled button that looks identical to an enabled one is
          not disabled as far as anyone reading the screen is concerned, and the
          available direction was the dimmed one.

          So the button for the current engine is not rendered at all. There is
          nothing to click, which is the honest representation: you cannot move to
          where you already are. Clicking the remaining one runs the whole
          sequence; there is no way to copy without verifying, or to switch without
          copying. */}
      <div className="db-danger" style={{ marginTop: "2rem" }}>
        <h3>Move the station</h3>
        <p style={{ fontSize: "0.875rem", color: "var(--color-muted)" }}>
          One button does the lot: checks nobody is listening, checks the target is
          usable, copies, proves both databases match row for row, then rebuilds and
          restarts. If any step fails it stops there and the station keeps running.
        </p>

        {roomBusy && (
          <div className="db-blocked">
            <strong>
              {status.listenerCount === null
                ? "Cannot tell whether anyone is listening"
                : `${status.listenerCount} listener(s) on air`}
            </strong>
            <p style={{ fontSize: "0.875rem", marginTop: "0.35rem" }}>
              {status.listenerCount === null
                ? "The listener list could not be read, so a move would be refused. Try again in a moment."
                : "A move restarts the station and would cut them off mid-song. Shut the station down in subwave to end these sessions."}
            </p>
            {status.listeners && status.listeners.length > 0 && (
              <ul>
                {status.listeners.map((l) => <li key={l.userId}>{l.name}</li>)}
              </ul>
            )}
          </div>
        )}

        <div className="db-actions" style={{ marginTop: "1rem" }}>
          {onPostgres ? (
            <button
              id="btn-db-move-to-sqlite"
              className="primary-btn"
              onClick={() => beginMove("sqlite")}
              disabled={toSqliteBlocked}
              title={
                roomBusy
                  ? "Nobody may be listening during a move"
                  : !targetFile.trim()
                    ? "Say where to save the SQLite copy first"
                    : undefined
              }
            >
              Move to SQLite
            </button>
          ) : (
            <button
              id="btn-db-move-to-postgres"
              className="primary-btn"
              onClick={() => beginMove("postgresql")}
              disabled={toPgBlocked}
              title={
                roomBusy
                  ? "Nobody may be listening during a move"
                  : !connectionValid
                    ? "Add the Postgres connection first"
                    : undefined
              }
            >
              Move to Postgres
            </button>
          )}
        </div>

        {!onPostgres && (
          <p style={{ fontSize: "0.875rem", color: "var(--color-muted)", marginTop: "0.5rem" }}>
            Moving to Postgres uses the connection below. It is checked as part of the move.
          </p>
        )}
        {onPostgres && (
          <div style={{ marginTop: "1rem" }}>
            <label htmlFor="input-db-move-target" style={{ display: "block", marginBottom: "0.35rem" }}>
              Where to save the SQLite copy
            </label>
            <input
              id="input-db-move-target"
              className="db-input"
              type="text"
              spellCheck={false}
              value={targetFile}
              onChange={(e) => { targetFileTouched.current = true; setTargetFile(e.target.value); resetMove(); }}
            />
            <p style={{ fontSize: "0.875rem", color: "var(--color-muted)", marginTop: "0.35rem" }}>
              Suggested. You only need to change it if you want the copy somewhere else — a
              file that already exists is never overwritten, and the running database is not
              touched until the final step.
            </p>
          </div>
        )}
      </div>

      {move && (
        <div className="db-danger" style={{ marginTop: "1.5rem" }}>
          <h3>
            Moving to {move.to === "postgresql" ? "Postgres" : "SQLite"}
          </h3>

          {/* The ordered steps. `done`/`failed` are terminal; everything else is
              in flight, so a failed flow stops visibly rather than sitting on a
              spinner that will never finish. */}
          <ol className="db-steps">
            {([
              ["checking", "Check nobody is listening, then confirm the target is usable"],
              ["copying", "Copy every table across"],
              ["verifying", "Prove both databases match, row for row"],
              ["switching", "Switch over, rebuild and restart"],
            ] as [MoveStep, string][]).map(([step, label]) => {
              const order: MoveStep[] = ["checking", "copying", "verifying", "switching"];
              const at = order.indexOf(step);
              const cur = order.indexOf(moveStep === "confirm" || moveStep === "target" ? "checking" : moveStep);
              const state =
                moveStep === "failed" && step === (lastFailed.current || "checking")
                  ? "fail"
                  : moveStep === "done" || cur > at
                    ? "pass"
                    : cur === at
                      ? "busy"
                      : "todo";
              return (
                <li key={step} className={`db-step ${state}`}>
                  <span className="db-step-mark">
                    {state === "pass" ? "\u2713" : state === "fail" ? "!" : state === "busy" ? "\u2022" : ""}
                  </span>
                  <span>{label}</span>
                </li>
              );
            })}
          </ol>

          {(moveStep === "confirm" || moveStep === "target") && (
            <div className="db-blocked">
              <strong>This restarts the station.</strong>
              <p style={{ fontSize: "0.875rem", marginTop: "0.35rem" }}>
                Everything is copied and checked first, and the live database is not touched
                until the final step — but the app does rebuild and restart, so the station
                is briefly unavailable and anyone listening is cut off.
              </p>
              <div className="db-actions" style={{ marginTop: "0.75rem" }}>
                <button id="btn-db-move-confirm" className="primary-btn" onClick={() => runMove(move.to)}>
                  Yes, move the station
                </button>
                <button
                  id="btn-db-move-cancel"
                  className="primary-btn"
                  style={{ background: "rgba(255,255,255,0.1)", color: "#fff" }}
                  onClick={resetMove}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {(moveProgressText || moveProgress.length > 0) && (
            <div className="db-progress" role="status" aria-live="polite" style={{ marginTop: "1rem" }}>
              {moveProgressText && (
                <div className="db-progress-head">
                  {moveBusy && <span className="spinner" style={{ width: "1rem", height: "1rem", borderWidth: "2px" }} />}
                  <span>{moveProgressText}</span>
                </div>
              )}
              {moveProgress.length > 0 && (
                <ul className="db-progress-list">
                  {moveProgress.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}
            </div>
          )}

          {probe && probe.checks.length > 0 && (
            <div className="db-checks" style={{ marginTop: "1rem" }}>
              {probe.checks.map((c) => (
                <div className={`db-check ${c.ok ? "pass" : "fail"}`} key={c.name}>
                  <span className="db-check-mark">{c.ok ? "\u2713" : "!"}</span>
                  <span className="db-check-name">{c.name}</span>
                  <span className="db-check-detail">{c.detail}</span>
                  {c.fix && <pre className="db-sql">{c.fix}</pre>}
                </div>
              ))}
              {probe.sql && !probe.ready && (
                <div className="db-check fail">
                  <span className="db-check-mark">\u2192</span>
                  <span className="db-check-name">Run this as a database administrator</span>
                  <span className="db-check-detail">
                    It promotes {probe.role} to what the station needs. Re-run the move afterwards.
                  </span>
                  <pre className="db-sql">{probe.sql}</pre>
                </div>
              )}
            </div>
          )}

          {moveTables && moveTables.length > 0 && (
            <table className="db-tables" style={{ marginTop: "1rem" }}>
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col" style={{ textAlign: "right" }}>{onPostgres ? "Postgres" : "SQLite"}</th>
                  <th scope="col" style={{ textAlign: "right" }}>{onPostgres ? "SQLite" : "Postgres"}</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {moveTables.map((t) => (
                  <tr key={t.model} className={t.match ? undefined : "mismatch"}>
                    <td>{t.model}</td>
                    <td className="num">{t.source.toLocaleString()}</td>
                    <td className="num">{t.target.toLocaleString()}</td>
                    <td className="verdict">{t.match ? "identical" : "differs"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {moveStep === "failed" && moveError && (
            <p style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#e06a5c" }}>{moveError}</p>
          )}

          {moveStep === "failed" && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--color-muted)" }}>
              The station is still running on {onPostgres ? "Postgres" : "SQLite"}. Nothing was switched.
            </p>
          )}
        </div>
      )}

      {(message || error) && (
        <p style={{ marginTop: "1.25rem", fontSize: "0.9rem", color: error ? "#e06a5c" : "var(--color-accent)" }}>
          {error || message}
        </p>
      )}
      {failing.length > 0 && !error && (
        <p style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--color-muted)" }}>
          {failing.length} check{failing.length === 1 ? "" : "s"} still failing.
        </p>
      )}
    </>
  );
}
