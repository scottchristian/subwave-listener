"use client";

// The first-run setup wizard.
//
// It exists so that setting up a station is a browser session rather than a
// terminal: five questions, and the application writes its own configuration,
// generates its own keys and creates its own database.
//
// Two rules shaped every decision here.
//
// SAFETY. This page writes Google credentials and names an administrator. It is
// reachable only while setup is unfinished — the gate is in proxy.ts and
// repeated in each API route — and it cannot be re-entered afterwards. Nothing
// on this page is ever rendered once the marker file exists.
//
// HONESTY ABOUT SLOW PARTS. Two steps take real time: the secrets step restarts
// the application, and the station step rebuilds it, because a Next.js build is
// what compiles a station name into the browser bundle. Both say so, and both
// survive a dropped connection by re-reading status on reload rather than
// pretending to know more than the server does.

import { useCallback, useEffect, useRef, useState } from "react";
import { addressIsPubliclyReachable } from "@/lib/addressreach";
import type { ReactNode } from "react";
import { RootNotice, HandoverCommands } from "./RootNotice";

type Steps = {
  secrets: boolean;
  google: boolean;
  signedIn: boolean;
  database: boolean;
  station: boolean;
};

type Status = {
  complete: boolean;
  runningAsRoot: boolean;
  nextauthUrl: string;
  googleConfigured: boolean;
  secretsReady: boolean;
  adminEmail: boolean;
  databaseConfigured: boolean;
  provider: string;
  stationName: string;
  backendUrl: string;
  pm2Configured: boolean;
  signedIn: { name?: string; isAdmin: boolean } | null;
  steps: Steps;
};

const STEP_ORDER = ["secrets", "google", "database", "station"] as const;
type StepId = (typeof STEP_ORDER)[number];

const STEP_TITLES: Record<StepId, string> = {
  secrets: "Security keys",
  google: "Sign-in",
  database: "Database",
  station: "Your station",
};

export default function SetupPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<StepId>("secrets");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [handover, setHandover] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/status", { cache: "no-store" });
      if (res.status === 404) {
        setStatus(null);
        return;
      }
      if (!res.ok) throw new Error("Could not read setup status");
      const d: Status = await res.json();
      setStatus(d);
      // Land on the first unfinished step, so a reload after the restart in the
      // middle of the flow continues rather than starting over.
      const first = STEP_ORDER.find((s) => !d.steps[s]) ?? "station";
      setStep(first);
    } catch {
      // The server is probably restarting, which is a normal part of two of the
      // steps. Say so instead of showing a failure.
      setMessage({
        kind: "warn",
        text: "Cannot reach the application. It may be restarting — this takes a few seconds. Retrying…",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a restart is in flight the server is briefly unreachable. Poll rather
  // than fail, and stop as soon as it answers.
  const pollUntilUp = useCallback(async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        if (res.ok) {
          await load();
          return true;
        }
      } catch {
        /* still down */
      }
    }
    return false;
  }, [load]);

  if (status === null) {
    return (
      <Shell>
        <Card>
          <h1>Setup</h1>
          <p className="muted">
            Either this station is already set up, or the application cannot be reached.
          </p>
          <p className="muted">
            If you have just finished setup, <a href="/">open your station</a>.
          </p>
        </Card>
      </Shell>
    );
  }

  const done = Object.values(status.steps).every(Boolean);

  return (
    <Shell>
      <Card>
        <Header done={done} />

        {done ? (
          <>
            <p className="ok">
              Your station is set up. This page is closed now, and the sign-in details you
              just entered are only reachable from the admin dashboard.
            </p>
            <Actions>
              <a className="btn primary" href="/">
                Open your station
              </a>
              <a className="btn" href="/admin">
                Admin dashboard
              </a>
            </Actions>
          </>
        ) : (
          <>
            <Progress current={step} steps={status.steps} />

            {status.runningAsRoot ? (
              <>
                <RootNotice onHandover={setHandover} />
                {handover ? (
                  <HandoverCommands plan={handover} onDismiss={() => setHandover(null)} />
                ) : null}
              </>
            ) : null}

            {message ? <Note kind={message.kind}>{message.text}</Note> : null}

            {step === "secrets" ? (
              <SecretsStep
                status={status}
                busy={busy}
                setBusy={setBusy}
                setMessage={setMessage}
                pollUntilUp={pollUntilUp}
                reload={load}
              />
            ) : null}

            {step === "google" ? (
              <GoogleStep
                status={status}
                busy={busy}
                setBusy={setBusy}
                setMessage={setMessage}
                pollUntilUp={pollUntilUp}
                reload={load}
              />
            ) : null}

            {step === "database" ? (
              <DatabaseStep
                status={status}
                busy={busy}
                setBusy={setBusy}
                setMessage={setMessage}
                pollUntilUp={pollUntilUp}
                reload={load}
              />
            ) : null}

            {step === "station" ? (
              <StationStep status={status} setMessage={setMessage} />
            ) : null}
          </>
        )}
      </Card>
    </Shell>
  );
}

/* ---------------------------------------------------------------- chrome -- */

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="setup-shell">
      <div className="setup-inner">{children}</div>
      <style
        dangerouslySetInnerHTML={{
          __html: CSS,
        }}
      />
    </main>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <section className="setup-card">{children}</section>;
}

function Header({ done }: { done: boolean }) {
  return (
    <>
      <h1>{done ? "Setup complete" : "Set up your station"}</h1>
      {!done ? (
        <p className="muted">
          Five short steps. You will need a Google Cloud project for sign-in, and the
          public address of your SUB/WAVE station. Everything else is handled here.
        </p>
      ) : null}
    </>
  );
}

function Progress({ current, steps }: { current: StepId; steps: Steps }) {
  const index = STEP_ORDER.indexOf(current);
  return (
    <ol className="steps" aria-label="Setup progress">
      {STEP_ORDER.map((id, i) => {
        const state = steps[id] ? "done" : i === index ? "current" : "todo";
        return (
          <li key={id} className={state}>
            <span className="dot" aria-hidden="true" />
            {STEP_TITLES[id]}
          </li>
        );
      })}
    </ol>
  );
}

function Note({ kind, children }: { kind: "ok" | "warn" | "error"; children: ReactNode }) {
  return <div className={`note ${kind}`}>{children}</div>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

/* ----------------------------------------------------------------- steps -- */

type StepProps = {
  status: Status;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setMessage: (m: { kind: "ok" | "warn" | "error"; text: string } | null) => void;
  pollUntilUp: () => Promise<boolean>;
  reload: () => Promise<void>;
};

function SecretsStep({ status, busy, setBusy, setMessage, pollUntilUp, reload }: StepProps) {
  const [key, setKey] = useState("");
  const [backedUp, setBackedUp] = useState(false);

  if (status.secretsReady && !key) {
    return (
      <>
        <h2>Security keys are in place</h2>
        <p className="muted">
          Your application has the two keys it needs. Nothing to do on this step.
        </p>
        <Actions>
          <button className="btn primary" onClick={() => location.reload()}>
            Continue
          </button>
        </Actions>
      </>
    );
  }

  return (
    <>
      <h2>Security keys</h2>
      <p className="muted">
        Two keys are generated for you. One is shown below and cannot be shown again.
      </p>
      <button className="btn primary" disabled={busy} onClick={async () => {
        setBusy(true);
        setMessage(null);
        try {
          const res = await fetch("/api/setup/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ step: "secrets" }),
          });
          const d = await res.json();
          if (!res.ok) {
            setMessage({ kind: "error", text: d.error || "Could not generate keys." });
            return;
          }
          setKey(d.piiEncryptionKey || "");
          setMessage({ kind: "ok", text: d.message || "Keys generated." });
          if (d.restarting) setMessage({ kind: "warn", text: "Keys written. Restarting the application…" });
        } catch {
          setMessage({ kind: "error", text: "Lost connection while generating keys." });
        } finally {
          setBusy(false);
        }
      }}>
        {busy ? "Generating…" : "Generate my keys"}
      </button>

      {key ? (
        <>
          <Note kind="warn">
            <strong>Back up this encryption key now.</strong>
            <p>
              It encrypts every listener name, email address and tip your station
              stores. If you lose it, that data cannot be read by anyone — including
              you. There is no reset, because there is nowhere to reset it from.
            </p>
            <div className="keyrow">
              <code className="key">{key}</code>
              <button
                className="btn"
                onClick={() => navigator.clipboard?.writeText(key)}
              >
                Copy
              </button>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={backedUp}
                onChange={(e) => setBackedUp(e.target.checked)}
              />
              I have stored this somewhere other than this server
            </label>
          </Note>
          <Actions>
            <button
              className="btn primary"
              disabled={!backedUp || busy}
              onClick={async () => {
                setBusy(true);
                await pollUntilUp();
                await reload();
                setBusy(false);
              }}
            >
              Continue
            </button>
            {!backedUp ? (
              <span className="muted small">Tick the box to continue.</span>
            ) : null}
          </Actions>
        </>
      ) : null}
    </>
  );
}

function GoogleStep({ status, busy, setBusy, setMessage, pollUntilUp, reload }: StepProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [nextauthUrl, setNextauthUrl] = useState(status.nextauthUrl || guessUrl());
  const [redirectUri, setRedirectUri] = useState("");

  const origin = nextauthUrl.replace(/\/+$/, "");
  const uri = origin ? `${origin}/api/auth/callback/google` : "";

  if (status.steps.signedIn) {
    return (
      <>
        <h2>You are signed in as the administrator</h2>
        <p className="muted">
          <strong>{status.signedIn?.name}</strong> is the owner of this station. Nothing
          more to do here.
        </p>
        <Actions>
          <button className="btn primary" onClick={() => location.reload()}>
            Continue
          </button>
        </Actions>
      </>
    );
  }

  return (
    <>
      <h2>Sign-in</h2>
      <p className="muted">
        Listeners sign in with Google. You need an application from Google Cloud — that
        part happens in your browser, on Google&apos;s site, and takes about five minutes.
      </p>

      <ol className="howto">
        <li>
          Open the <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> and
          create a project.
        </li>
        <li>
          Under <strong>APIs &amp; Services → OAuth consent screen</strong>, choose
          External, name the app, and enter your own email as the support contact. Add
          yourself under <strong>Test users</strong> while you are setting up.
        </li>
        <li>
          Under <strong>APIs &amp; Services → Credentials</strong>, create an{" "}
          <strong>OAuth client ID</strong> of type <strong>Web application</strong>.
        </li>
        <li>Copy the client ID and client secret into the boxes below.</li>
      </ol>

      <Field
        label="This app's public address"
        hint="Where listeners will reach you. Leave as it is if you are on a server."
        value={nextauthUrl}
        onChange={setNextauthUrl}
      />

      {uri ? (
        <Note kind="warn">
          <strong>Add this exact address to your Google app</strong>, under Authorized
          redirect URIs. It must match character for character — a different protocol,
          a different domain, or a trailing slash will all stop sign-in working.
          <div className="keyrow">
            <code className="key">{uri}</code>
            <button className="btn" onClick={() => navigator.clipboard?.writeText(uri)}>
              Copy
            </button>
          </div>
        </Note>
      ) : null}

      <Field label="Google client ID" hint="Ends in .apps.googleusercontent.com" value={clientId} onChange={setClientId} />
      <Field label="Google client secret" hint="Starts with GOCSPX-" type="password" value={clientSecret} onChange={setClientSecret} />
      <Field
        label="Your email address"
        hint="The first person to sign in with this address becomes the administrator. Use your own."
        type="email"
        value={adminEmail}
        onChange={setAdminEmail}
      />

      {status.googleConfigured ? (
        <Note kind="ok">
          Credentials are already saved. Enter them again only to change them — saving
          again will restart the application.
        </Note>
      ) : null}

      <Actions>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              const res = await fetch("/api/setup/apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  step: "google",
                  clientId,
                  clientSecret,
                  adminEmail,
                  nextauthUrl,
                }),
              });
              const d = await res.json();
              if (!res.ok) {
                setRedirectUri(d.redirectUri || "");
                setMessage({ kind: "error", text: d.error || "Could not save those details." });
                return;
              }
              setRedirectUri(d.redirectUri || uri);
              setMessage({
                kind: d.restarting ? "warn" : "ok",
                text: d.restarting
                  ? "Saved. Restarting the application — this takes a few seconds."
                  : "Saved. Restart the application by hand for it to take effect.",
              });
              if (d.restarting) {
                const back = await pollUntilUp();
                if (back) setMessage({ kind: "ok", text: "Saved and applied. Now sign in below." });
              }
              await reload();
            } catch {
              setMessage({ kind: "error", text: "Lost connection while saving." });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking…" : "Check and save"}
        </button>
        {redirectUri ? (
          <span className="muted small">Check this is registered with Google: {redirectUri}</span>
        ) : null}
      </Actions>

      {status.googleConfigured ? (
        <>
          <hr />
          <h3>Sign in</h3>
          <p className="muted">
            With the credentials saved, sign in with the email address above. That account
            becomes the administrator.
          </p>
          <Actions>
            <button
              className="btn primary"
              onClick={async () => {
                const { signIn } = await import("next-auth/react");
                await signIn("google", { callbackUrl: "/setup" });
              }}
            >
              Sign in with Google
            </button>
          </Actions>
        </>
      ) : null}
    </>
  );
}

function DatabaseStep({ status, busy, setBusy, setMessage, pollUntilUp, reload }: StepProps) {
  const [provider, setProvider] = useState<"sqlite" | "postgresql">(status.provider === "postgresql" ? "postgresql" : "sqlite");
  const [url, setUrl] = useState("");
  const [sqlitePath, setSqlitePath] = useState("../data/station.db");

  if (status.databaseConfigured) {
    return (
      <>
        <h2>Your database is ready</h2>
        <p className="muted">
          Running on <strong>{status.provider || "sqlite"}</strong>. You can move to the
          other one later from the admin dashboard, without losing anything.
        </p>
        <Actions>
          <button className="btn primary" onClick={() => location.reload()}>
            Continue
          </button>
        </Actions>
      </>
    );
  }

  return (
    <>
      <h2>Database</h2>
      <p className="muted">
        This is where your listeners, their likes and their requests are kept.
      </p>

      <div className="choices">
        <button
          className={`choice ${provider === "sqlite" ? "on" : ""}`}
          onClick={() => setProvider("sqlite")}
        >
          <strong>SQLite</strong>
          <span>Recommended. One file, nothing to install, easy to back up.</span>
        </button>
        <button
          className={`choice ${provider === "postgresql" ? "on" : ""}`}
          onClick={() => setProvider("postgresql")}
        >
          <strong>Postgres</strong>
          <span>
            For keeping the database on a different machine, or on a managed service.
            Takes longer to set up.
          </span>
        </button>
      </div>

      {provider === "sqlite" ? (
        <Field
          label="Where to put the file"
          hint="A path relative to your project folder. ../data/ keeps it beside the application."
          value={sqlitePath}
          onChange={setSqlitePath}
        />
      ) : (
        <>
          <Note kind="warn">
            <strong>One step has to be done by hand.</strong> Creating the database role
            and granting it permissions needs superuser access, which no web page can
            have. Run these in your database as a superuser, connected to your station
            database, replacing the names:
            <pre>{PG_SQL}</pre>
            <p>
              Then paste the connection URL below. Use your provider&apos;s{" "}
              <strong>direct</strong> address rather than a pooled one — a pooler will
              not authenticate a role you created yourself.
            </p>
          </Note>
          <Field
            label="Postgres connection URL"
            hint="postgresql://user:password@host:5432/database"
            value={url}
            onChange={setUrl}
          />
        </>
      )}

      <Actions>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMessage({ kind: "warn", text: "Preparing the database. This can take a minute…" });
            try {
              const res = await fetch("/api/setup/apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ step: "database", provider, databaseUrl: url, sqlitePath }),
              });
              const d = await res.json();
              if (!res.ok) {
                setMessage({
                  kind: "error",
                  text: `${d.error || "Could not prepare the database."}${d.output ? `\n\n${d.output}` : ""}`,
                });
                return;
              }
              setMessage({ kind: "warn", text: "Database ready. Restarting the application…" });
              await pollUntilUp();
              setMessage({ kind: "ok", text: "Database ready and applied." });
            } catch {
              setMessage({ kind: "error", text: "Lost connection while preparing the database." });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Working…" : provider === "sqlite" ? "Create the database" : "Connect to Postgres"}
        </button>
      </Actions>
    </>
  );
}

type Probe = {
  ok: boolean;
  /** The station name the host reports, when it reports one. */
  stationName?: string | null;
  /** A human sentence saying what happened, for the operator. */
  detail: string;
};

function StationStep({ status, setMessage }: { status: Status; setMessage: (m: { kind: "ok" | "warn" | "error"; text: string } | null) => void }) {
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [about, setAbout] = useState("");
  const [backendUrl, setBackendUrl] = useState(status.backendUrl || "");
  const [nextauthUrl, setNextauthUrl] = useState(status.nextauthUrl || guessUrl());
  const [discoverable, setDiscoverable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Null until tested. "Finish setup" stays disabled until this says ok, so a
  // mistyped address is caught here rather than after the minute-long build.
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const probedFor = useRef<string | null>(null);

  /**
   * Ask the address whether it is a working SUB/WAVE station, and take its answer
   * from the same response.
   *
   * Runs in the browser on purpose. That is the listener's own path — the same URL
   * and the same cross-origin rules the player will use — so a pass here means the
   * player will actually load, including the CORS question that a server-side probe
   * would not catch. It also means this server never fetches an operator-supplied
   * URL, so adding the check adds no new unauthenticated endpoint.
   */
  const testConnection = async (): Promise<Probe> => {
    const raw = backendUrl.trim();
    if (!raw) return { ok: false, detail: "Enter your station address first." };
    let base: URL;
    try {
      base = new URL(raw);
      if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("scheme");
    } catch {
      return { ok: false, detail: "That has to be a full http:// or https:// address." };
    }
    const api = base.href.replace(/\/+$/, "").endsWith("/api")
      ? base.href.replace(/\/+$/, "")
      : base.href.replace(/\/+$/, "") + "/api";

    try {
      const res = await fetch(`${api}/now-playing`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      if (!res.ok) {
        return { ok: false, detail: `The server answered ${res.status}. Check the address, and that it includes /api.` };
      }
      const data: any = await res.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return { ok: false, detail: "That address answered, but not like a SUB/WAVE station." };
      }
      // dj.station is the station's own name; dj.tagline is its tagline when set.
      // Both are read straight from the host so they cannot disagree with it.
      const stationName = typeof data?.dj?.station === "string" ? data.dj.station.trim() : "";
      const taglineFromHost = typeof data?.dj?.tagline === "string" ? data.dj.tagline.trim() : "";
      const track = data?.nowPlaying?.title
        ? `${data.nowPlaying.title}${data.nowPlaying.artist ? " \u2014 " + data.nowPlaying.artist : ""}`
        : null;
      return {
        ok: true,
        stationName: stationName || null,
        detail: track ? `Connected. On air: ${track}` : "Connected. The station is reachable, though nothing is playing right now.",
        // Carried on the result so the caller can fill the tagline without a
        // second round trip.
        ...(taglineFromHost ? { taglineFromHost } : {}),
      } as Probe;
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError";
      // The two failures need different advice. A private address that fails is
      // unreachable from here *and* from every listener, so the problem is local
      // (nothing is listening on it). A public address that fails is either the
      // wrong address or the station is down \u2014 and blaming the network would send
      // the operator off to check their router for a name that never resolved.
      const priv = addressIsPubliclyReachable(raw);
      return {
        ok: false,
        detail: timedOut
          ? `No answer after 15 seconds. ${priv
              ? "Check the address, and that the station is running."
              : "Nothing is answering on your own network either, so this is not a reachability problem \u2014 check the address and that the station is running."}`
          : priv
            ? "Could not reach that address. Check it for typos, and that the station is running \u2014 including whether it needs /api on the end."
            : "Could not reach that address from your own network, so nothing is listening on it. Check the address, and that the station is running.",
      };
    }
  };

  const runTest = async () => {
    setProbing(true);
    setMessage(null);
    const result = await testConnection();
    setProbe(result);
    probedFor.current = backendUrl.trim();
    if (result.ok) {
      // Fill from the host rather than asking the operator to retype what it
      // already knows. Never overwrite a name they have typed.
      setName((prev) => (prev.trim() ? prev : result.stationName || ""));
    }
    setProbing(false);
  };

  /**
   * Retest automatically the first time an address stops being the one that
   * passed. Editing the field is the operator telling us it changed, and a stale
   * green tick on a new address is exactly the lie this gate exists to prevent.
   */
  useEffect(() => {
    if (probedFor.current === null) return;
    if (probedFor.current === backendUrl.trim() && probe?.ok) return;
    setProbe(null);
  }, [backendUrl]);

  // A failed test is not the only reason to stop: a private address would pass
  // the test from this machine and still fail for every listener.
  const addressLooksPublic = addressIsPubliclyReachable(backendUrl);
  const canFinish = !!probe?.ok && addressLooksPublic && !probing && !busy;

  if (done) {
    return (
      <>
        <h2>Your station is ready</h2>
        <p className="ok">
          <strong>{name}</strong> is set up. The application has restarted, so the name is
          live.
        </p>
        <p className="muted">
          Two things worth doing next: approve your first listeners from the admin
          dashboard, and check the audio actually plays.
        </p>
        <Actions>
          <a className="btn primary" href="/">
            Open your station
          </a>
          <a className="btn" href="/admin">
            Admin dashboard
          </a>
        </Actions>
      </>
    );
  }

  return (
    <>
      <h2>Your station</h2>
      <p className="muted">
        The last step. This one rebuilds the application, because a station name is
        compiled into the page that listeners load — changing it is not just a
        restart. Expect about a minute.
      </p>

      <Field
        label="Station name"
        hint="Appears in the header and the browser tab. Test the connection below and this fills itself in from the station — edit it if you want the player to say something different."
        value={name}
        onChange={setName}
      />
      <Field label="Short tagline" hint="One line, shown under the logo" value={tagline} onChange={setTagline} />
      <Field label="Description" hint="Used for the page metadata and the install prompt" value={description} onChange={setDescription} />
      <Field label="About" hint="The longer text on the sign-in screen" value={about} onChange={setAbout} />

      <Field
        label="Your SUB/WAVE station address"
        hint="The public address of your station — the one a browser outside your home can open. Not a home network address like 192.168.x.x."
        value={backendUrl}
        onChange={setBackendUrl}
      />

      <Actions>
        <button className="btn" disabled={probing || !backendUrl.trim()} onClick={runTest}>
          {probing ? "Testing…" : "Test connection"}
        </button>
      </Actions>

      {probe ? (
        <Note kind={probe.ok ? (addressLooksPublic ? "ok" : "warn") : "error"}>
          {probe.ok ? (
            addressLooksPublic ? (
              <p id="probe-ok">{probe.detail}</p>
            ) : (
              <p id="probe-ok-private">
                <strong>It answered, but your listeners cannot reach that address.</strong> This
                browser is on the same network as it, so the test passed {'—'} every listener's
                browser would not. See the note below.
              </p>
            )
          ) : (
            <p id="probe-failed">{probe.detail}</p>
          )}
        </Note>
      ) : null}

      {backendUrl.trim() && !addressLooksPublic ? (
        <Note kind="warn">
          <p id="address-private-note">
            <strong>That address is only reachable from this machine or your own network.</strong>{" "}
            Your listeners' browsers talk to the station directly {'—'} now-playing, the schedule,
            cover art {'—'} so they need an address that works from the public internet. This one will
            play perfectly here, and nowhere else.
          </p>
          <p>
            If the station is only ever listened to from inside your own network, carry on: it will
            work for you. If it is a public station, use the address that opens from a browser on
            mobile data, with the ports your router needs forwarded.
          </p>
        </Note>
      ) : null}
      <Field
        label="This app's public address"
        hint="Must match the one you registered with Google"
        value={nextauthUrl}
        onChange={setNextauthUrl}
      />

      <label className="check">
        <input type="checkbox" checked={discoverable} onChange={(e) => setDiscoverable(e.target.checked)} />
        Let search engines list this station
      </label>
      {!discoverable ? (
        <p className="muted small">
          Leave this off. Your station is behind sign-in and approval, so there is nothing
          for a crawler to find, and the only thing indexing it reveals is its name.
        </p>
      ) : null}

      <Actions>
        <button
          className="btn primary"
          disabled={busy || !canFinish}
          onClick={async () => {
            setBusy(true);
            setMessage({ kind: "warn", text: "Building your station. This takes about a minute — do not close this tab." });
            try {
              const res = await fetch("/api/setup/apply", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // No timeout: the build is genuinely slow and a client-side abort
                // would just mean the operator thinks it failed when it did not.
                body: JSON.stringify({
                  step: "station",
                  name,
                  tagline,
                  description,
                  about,
                  backendUrl,
                  nextauthUrl,
                  discoverable,
                }),
              });
              const d = await res.json();
              if (!res.ok) {
                setMessage({ kind: "error", text: d.error || "Could not finish setup." });
                return;
              }
              setDone(true);
            } catch {
              setMessage({
                kind: "warn",
                text: "Lost connection during the build. It may still have succeeded — reload this page to check.",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Building… this takes about a minute" : "Finish setup"}
        </button>
        {!canFinish && !busy ? (
          <span className="muted small" id="finish-blocked-why">
            {!backendUrl.trim()
              ? "Enter your station address."
              : probing
                ? "Testing the connection…"
                : !probe
                  ? "Test the connection first."
                  : !probe.ok
                    ? "The connection did not pass."
                    : "Use an address your listeners can reach."}
          </span>
        ) : null}
      </Actions>
    </>
  );
}

/* ---------------------------------------------------------------- pieces -- */

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {hint ? <span className="hint">{hint}</span> : null}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const guessUrl = () =>
  typeof window === "undefined" ? "" : `${window.location.origin}`;

const PG_SQL = `ALTER ROLE my_station_app LOGIN;
GRANT CONNECT ON DATABASE my_station TO my_station_app;
GRANT USAGE, CREATE ON SCHEMA public TO my_station_app;
ALTER SCHEMA public OWNER TO my_station_app;`;

const CSS = `
.setup-shell{min-height:100vh;display:flex;align-items:flex-start;justify-content:center;
padding:3rem 1rem;background:var(--color-bg,#06101e);color:var(--color-text,#dce8f5);
font-family:var(--font-body,system-ui,sans-serif);line-height:1.6}
.setup-inner{width:100%;max-width:46rem}
.setup-card{background:var(--color-surface,#0d1f35);border:1px solid var(--color-border,#1a3050);
border-radius:14px;padding:2rem}
h1{font-size:1.9rem;margin:0 0 .5rem}
h2{font-size:1.3rem;margin:1.75rem 0 .5rem}
h3{font-size:1.05rem;margin:1.5rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--color-muted,#6a8ba8)}
.small{font-size:.85rem}
.ok{color:#7bd88f}
a{color:var(--color-accent,#4e9fd4)}
.steps{list-style:none;display:flex;gap:1rem;padding:0;margin:1.5rem 0;flex-wrap:wrap}
.steps li{display:flex;align-items:center;gap:.5rem;font-size:.9rem;color:var(--color-muted,#6a8ba8)}
.steps .dot{width:.6rem;height:.6rem;border-radius:50%;background:currentColor;display:inline-block}
.steps .done{color:#7bd88f}
.steps .current{color:var(--color-text,#dce8f5);font-weight:600}
.note{border:1px solid;border-radius:10px;padding:1rem;margin:1.25rem 0;font-size:.92rem}
.note.ok{border-color:rgba(123,216,143,.4);background:rgba(123,216,143,.08)}
.note.warn{border-color:rgba(224,180,106,.45);background:rgba(224,180,106,.08)}
.note.error{border-color:rgba(224,106,92,.5);background:rgba(224,106,92,.1)}
.note p{margin:.5rem 0}
.field{display:block;margin:1.1rem 0}
.field .label{display:block;font-weight:600;font-size:.95rem}
.field .hint{display:block;color:var(--color-muted,#6a8ba8);font-size:.83rem;margin-bottom:.35rem}
.field input{width:100%;padding:.6rem .75rem;border-radius:8px;border:1px solid var(--color-border,#1a3050);
background:#0a1728;color:var(--color-text,#dce8f5);font:inherit;box-sizing:border-box}
.field input:focus{outline:2px solid var(--color-accent,#4e9fd4);outline-offset:1px}
.btn{display:inline-block;padding:.65rem 1.1rem;border-radius:999px;border:1px solid var(--color-border,#1a3050);
background:rgba(255,255,255,.06);color:var(--color-text,#dce8f5);font:inherit;font-weight:600;
cursor:pointer;text-decoration:none;margin:.25rem .5rem .25rem 0}
.btn.primary{background:var(--color-accent,#4e9fd4);border-color:transparent;color:#04121f}
.btn:disabled{opacity:.5;cursor:default}
.actions{margin-top:1.5rem;display:flex;align-items:center;flex-wrap:wrap}
.choices{display:flex;gap:1rem;flex-wrap:wrap;margin:1.25rem 0}
.choice{flex:1 1 15rem;text-align:left;padding:1rem;border-radius:10px;cursor:pointer;font:inherit;
background:rgba(255,255,255,.04);border:1px solid var(--color-border,#1a3050);color:var(--color-text,#dce8f5)}
.choice.on{border-color:var(--color-accent,#4e9fd4);background:rgba(78,159,212,.12)}
.choice span{display:block;color:var(--color-muted,#6a8ba8);font-size:.85rem;margin-top:.3rem}
.check{display:flex;gap:.6rem;align-items:flex-start;margin:1rem 0;font-size:.92rem}
.keyrow{display:flex;gap:.5rem;align-items:center;margin:.75rem 0;flex-wrap:wrap}
.key{background:rgba(0,0,0,.35);padding:.5rem .6rem;border-radius:6px;font-size:.82rem;
word-break:break-all;flex:1 1 18rem;color:#cfe3f7}
pre{background:rgba(0,0,0,.4);padding:.85rem;border-radius:8px;overflow-x:auto;font-size:.8rem;line-height:1.5}
hr{border:0;border-top:1px solid var(--color-border,#1a3050);margin:2rem 0}
.notice{border:1px solid;border-radius:10px;padding:1.1rem 1.25rem;margin:1.5rem 0;font-size:.93rem}
.notice h3{margin:0 0 .6rem;font-size:1.1rem}
.notice h4{margin:1.1rem 0 .4rem;font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;color:var(--color-muted,#6a8ba8)}
.notice.bad{border-color:rgba(224,106,92,.55);background:rgba(224,106,92,.10)}
.notice.warn{border-color:rgba(224,180,106,.45);background:rgba(224,180,106,.08)}
.notice.good{border-color:rgba(123,216,143,.4);background:rgba(123,216,143,.08)}
.plainlist,.ticklist{margin:.4rem 0;padding-left:1.2rem;color:var(--color-text,#dce8f5)}
.plainlist li,.ticklist li{margin:.25rem 0}
.ticklist{color:#7bd88f}
.choice-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1.1rem}
.codeblock{position:relative;margin:.5rem 0}
.codeblock .btn.small{position:absolute;top:.5rem;right:.5rem;font-size:.72rem;padding:.3rem .6rem}
.errline{background:rgba(0,0,0,.3);border-left:3px solid #e06a5c;padding:.6rem .75rem;border-radius:0 6px 6px 0;white-space:pre-wrap;font-size:.85rem}
.howto{padding-left:1.1rem;color:var(--color-muted,#6a8ba8);font-size:.92rem}
.howto li{margin:.4rem 0}
@media (max-width:640px){.setup-card{padding:1.25rem}}
`;
