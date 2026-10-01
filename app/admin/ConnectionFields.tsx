// Connection details, entered either way.
//
// The same connection is represented twice — as one string and as separate
// fields — and the two stay in step. The rule that makes this bearable rather
// than a fight: whichever box you touched last is authoritative. Typing in the
// string parses into the fields and never rewrites the string (so the cursor
// stays put); editing a field rebuilds the string and never touches the fields.
//
// Everything here is local component state. The password lives in memory for
// as long as the panel is open and is never sent anywhere except the probe
// request, whose response comes back masked.

export type ConnFields = {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
  sslmode: string;
};

export const EMPTY_FIELDS: ConnFields = {
  user: "",
  password: "",
  host: "",
  port: "5432",
  database: "",
  sslmode: "require",
};

const SSL_MODES = ["require", "disable", "verify-full", "verify-ca", "prefer"];

/** Percent-encode a URL component. `!` and friends stay literal, which is valid. */
const enc = (s: string) => encodeURIComponent(s ?? "");

export function buildUrl(f: ConnFields): string {
  // The "@" separates credentials from host, so it is always present — even
  // with an empty password, which is a real case for a string pasted without
  // credentials. Leaving it out silently welds the password to the hostname.
  const creds = f.user || f.password ? `${enc(f.user)}:${enc(f.password)}@` : "";
  const host = f.host || "host";
  const port = f.port ? `:${f.port}` : ":5432";
  const db = f.database ? `/${enc(f.database)}` : "";
  const q = f.sslmode ? `?sslmode=${enc(f.sslmode)}` : "";
  return `postgresql://${creds}${host}${port}${db}${q}`;
}

export type ParseResult = { ok: true; fields: ConnFields } | { ok: false; error: string };

export function parseUrl(raw: string): ParseResult {
  const v = raw.trim();
  if (!v) return { ok: false, error: "" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: "Not a complete URL yet — it needs a host and database." };
  }
  if (!/^postgres(ql)?:$/i.test(u.protocol)) {
    return { ok: false, error: "Must start with postgresql://" };
  }
  if (!u.hostname) {
    return { ok: false, error: "No host in that URL." };
  }
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!database) {
    return { ok: false, error: "No database name in that URL." };
  }
  return {
    ok: true,
    fields: {
      user: decodeURIComponent(u.username),
      // A URL with no password gives "" here, which is the right answer.
      password: decodeURIComponent(u.password),
      host: u.hostname,
      port: u.port || "5432",
      database,
      sslmode: u.searchParams.get("sslmode") || "require",
    },
  };
}

type Props = {
  url: string;
  fields: ConnFields;
  urlError: string;
  showPassword: boolean;
  onUrl: (v: string) => void;
  onField: (k: keyof ConnFields, v: string) => void;
  onTogglePassword: () => void;
};

const FIELDS: { key: keyof ConnFields; label: string; placeholder: string; hint?: string; type?: string }[] = [
  { key: "user", label: "Username", placeholder: "app_user" },
  {
    key: "password",
    label: "Password",
    placeholder: "••••••••",
    type: "password",
    hint: "Encoded into the connection string automatically, so any character is safe.",
  },
  {
    key: "host",
    label: "Server address",
    placeholder: "db.example.cloud.provider.dev",
    hint: "Managed Postgres usually needs the direct port, not the pooled one.",
  },
  { key: "port", label: "Port", placeholder: "5432" },
  { key: "database", label: "Database", placeholder: "station" },
];

export default function ConnectionFields({
  url,
  fields,
  urlError,
  showPassword,
  onUrl,
  onField,
  onTogglePassword,
}: Props) {
  const id = (k: string) => `db-conn-${k}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "0.75rem" }}>
      <div>
        <label htmlFor={id("string")} style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.3rem" }}>
          Connection string
        </label>
        <input
          id={id("string")}
          className="db-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="postgresql://app_user:password@host:5432/station?sslmode=require"
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          aria-describedby={urlError ? id("string-err") : undefined}
          aria-invalid={urlError ? true : undefined}
        />
        {urlError ? (
          <p id={id("string-err")} style={{ color: "#e06a5c", fontSize: "0.8rem", marginTop: "0.3rem" }}>
            {urlError}
          </p>
        ) : (
          <p style={{ color: "var(--color-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
            Paste a string and the fields below fill in. Edit a field and this updates.
          </p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }} aria-hidden="true">
        <span style={{ flex: 1, height: "1px", background: "var(--color-border)" }} />
        <span style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>or</span>
        <span style={{ flex: 1, height: "1px", background: "var(--color-border)" }} />
      </div>

      <div className="db-fieldgrid">
        {FIELDS.map((f) => (
          <div key={f.key} className="db-field">
            <label htmlFor={id(f.key)} style={{ display: "block", fontSize: "0.8rem", color: "var(--color-muted)", marginBottom: "0.25rem" }}>
              {f.label}
            </label>
            <div style={{ position: "relative" }}>
              <input
                id={id(f.key)}
                className="db-input"
                type={f.key === "password" && !showPassword ? "password" : f.type || "text"}
                autoComplete={f.key === "password" ? "current-password" : "off"}
                spellCheck={false}
                placeholder={f.placeholder}
                value={fields[f.key]}
                onChange={(e) => onField(f.key, e.target.value)}
                style={f.key === "password" ? { paddingRight: "4.5rem" } : undefined}
              />
              {f.key === "password" && (
                <button
                  type="button"
                  id={id("toggle-password")}
                  onClick={onTogglePassword}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  style={{
                    position: "absolute", right: "0.35rem", top: "50%", transform: "translateY(-50%)",
                    background: "transparent", border: "none", color: "var(--color-muted)",
                    fontSize: "0.75rem", cursor: "pointer", padding: "0.3rem 0.45rem", borderRadius: "6px",
                  }}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {f.hint && (
              <p style={{ color: "var(--color-muted)", fontSize: "0.75rem", marginTop: "0.25rem", lineHeight: 1.4 }}>
                {f.hint}
              </p>
            )}
          </div>
        ))}

        <div className="db-field">
          <label htmlFor={id("sslmode")} style={{ display: "block", fontSize: "0.8rem", color: "var(--color-muted)", marginBottom: "0.25rem" }}>
            SSL mode
          </label>
          <select
            id={id("sslmode")}
            className="db-input"
            value={fields.sslmode}
            onChange={(e) => onField("sslmode", e.target.value)}
          >
            {SSL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p style={{ color: "var(--color-muted)", fontSize: "0.75rem", marginTop: "0.25rem", lineHeight: 1.4 }}>
            Only use <code style={{ color: "var(--color-text)" }}>disable</code> for a database on this machine.
          </p>
        </div>
      </div>
    </div>
  );
}
