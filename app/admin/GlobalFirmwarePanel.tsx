"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared firmware: one image for every wall screen.
 *
 * THREE THINGS THIS PANEL IS CAREFUL NOT TO SAY.
 *
 * 1. "PUBLISHED" IS NOT "INSTALLED". Publishing moves a pointer that lets every
 *    compatible screen *see* the release. A screen installs it only when someone
 *    taps Update firmware in its own Settings, and a screen that never asks keeps
 *    running what it has. The copy below says that on every publish, because an
 *    operator who reads "published" as "rolled out" will believe a wall is on a
 *    release it has never seen.
 *
 * 2. NOBODY KNOWS WHO IS UP TO DATE. Installed versions arrive in heartbeats, and
 *    a screen that has stopped checking in is not evidence of anything. This
 *    panel reports the last thing each screen said (in the device rows below)
 *    and never claims the fleet has caught up.
 *
 * 3. THERE IS NO DOWNLOAD HERE. The artifact is not addressable from the admin
 *    UI: the bytes are streamed only to a screen's own accepted attempt, over its
 *    bearer-authenticated route. A link on this page would be a second, weaker
 *    path to the same image, so there isn't one.
 *
 * Upload and publish are separate on purpose. Validating a file is cheap and
 * reversible; offering it to the fleet is neither, so the second step is an
 * explicit click with the version, hash and consequence shown inline.
 */

type Release = {
  id: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  descriptorProject: string;
  descriptorVersion: string;
  chipId: number;
  createdAt: string;
  publishedAt: string | null;
  withdrawnAt: string | null;
};

type ReleaseRow = Release & { attemptCount: number };

type ActiveAttempt = {
  id: string;
  deviceId: string;
  deviceName: string;
  releaseId: string;
  version: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
};

type Catalog = {
  published: Release | null;
  releases: ReleaseRow[];
  activeAttempts: ActiveAttempt[];
};

type Pending = { kind: "publish" | "withdraw"; release: ReleaseRow };

const PHASE_LABEL: Record<string, string> = {
  requested: "requested",
  accepted: "accepted",
  downloading: "downloading",
  verifying: "verifying the download",
  installing: "installing",
  rebooting: "rebooting",
  succeeded: "installed",
  failed: "failed",
  // The screen kept the image it was already running. Saying so is the point:
  // "failed" alone would suggest something may have been half-written.
  rolled_back: "rolled back to the previous image",
  // Silence is not success. A screen that stopped reporting is reported as
  // unknown rather than left in "installing" for ever.
  unknown: "outcome unknown (stopped reporting)",
  rejected: "rejected",
};

const phaseLabel = (phase: string) => PHASE_LABEL[phase] ?? `unrecognised phase “${phase}”`;

const shortSha = (sha: string) => sha.slice(0, 12);

const sizeLabel = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");

/**
 * A response body we can read even when it is not JSON.
 *
 * A 413 is the case that matters: the production vhost may still answer with
 * NGINX's HTML error page before this route runs, and `res.json()` on that
 * throws — which used to surface as "the upload failed" with no explanation.
 */
async function readBody(res: Response): Promise<any> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default function GlobalFirmwarePanel({ hidden, targetCount }: { hidden: boolean; targetCount?: number }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Upload and publish/withdraw are separate state machines. A slow upload must
  // not disable the publish control on a release that is already registered, and
  // an error from one must not read as an error from the other.
  const [version, setVersion] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // The attempt the operator has armed for cancellation. Same two-step rule as
  // publish: a destructive-looking click is not done on the first press.
  const [cancelling, setCancelling] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await fetch("/api/admin/firmware/ota", { cache: "no-store" });
      // A deploy that predates this route answers 404. Say the feature is not
      // there instead of rendering an upload form that can only fail.
      if (res.status === 404) {
        if (seq === loadSeq.current) {
          setUnavailable(true);
          setLoadError(null);
        }
        return;
      }
      if (res.status === 403) {
        // Plain text, not JSON: this route refuses before it reads anything.
        if (seq === loadSeq.current) {
          setUnavailable(false);
          setLoadError("You are not signed in as an operator.");
        }
        return;
      }
      if (!res.ok) {
        if (seq === loadSeq.current) {
          setLoadError(`The release list could not be loaded (HTTP ${res.status}).`);
        }
        return;
      }
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      setCatalog({
        published: data?.published ?? null,
        releases: Array.isArray(data?.releases) ? data.releases : [],
        activeAttempts: Array.isArray(data?.activeAttempts) ? data.activeAttempts : [],
      });
      setUnavailable(false);
      setLoadError(null);
    } catch {
      if (seq === loadSeq.current) setLoadError("The release list could not be loaded.");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  // Only while the Screens tab is open. The panel is mounted for the life of the
  // admin page, and a hidden tab has no reason to keep asking.
  useEffect(() => {
    if (hidden) return;
    void load();
  }, [hidden, load]);

  // A confirmation is transient: leaving the tab and coming back must not leave
  // a "Publish 1.15.0?" prompt armed for a click nobody re-read.
  useEffect(() => {
    if (hidden) setPending(null);
  }, [hidden]);

  async function uploadRelease(e: React.FormEvent) {
    e.preventDefault();
    // A second submit can arrive through Enter before React re-renders the
    // disabled button. Validating twice would register twice for the same file
    // and then explain a conflict nobody caused.
    if (uploading) return;
    const chosen = file;
    if (!chosen) {
      setUploadError("Choose the compiled app image first.");
      return;
    }
    if (!version.trim()) {
      setUploadError("Give the release a dotted version, such as 1.15.0.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadNotice(null);
    try {
      const form = new FormData();
      form.append("firmware", chosen);
      form.append("version", version.trim());
      const res = await fetch("/api/admin/firmware/ota", { method: "POST", body: form, cache: "no-store" });
      const data = await readBody(res);
      if (res.status === 403) {
        setUploadError("You are not signed in as an operator.");
        return;
      }
      if (res.status === 413) {
        // The image is several megabytes. A proxy still carrying NGINX's default
        // 1 MB body limit refuses it before the route ever sees a byte, and that
        // refusal is HTML — so this message names the likely cause instead of
        // reporting a bare status code.
        setUploadError(
          "That file is over the server's upload limit. A shared screen image is several MB; if the production proxy still uses NGINX's default 1 MB limit, it is refusing the upload before the app sees it.",
        );
        return;
      }
      if (!res.ok) {
        setUploadError(data?.error || `That image was not accepted (HTTP ${res.status}).`);
        return;
      }
      setUploadNotice(
        data?.created
          ? `Version ${data.release.version} is registered (SHA-256 ${shortSha(data.release.sha256)}). No screen is offered it until you publish it.`
          : `Those exact bytes are already registered as version ${data.release.version}. Nothing changed, and it is still unpublished unless it was published before.`,
      );
      setVersion("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch {
      setUploadError("The upload did not reach the server.");
    } finally {
      setUploading(false);
    }
  }

  async function confirmAction() {
    if (acting) return;
    const choice = pending;
    if (!choice) return;
    setActing(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await fetch("/api/admin/firmware/ota", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: choice.kind, releaseId: choice.release.id }),
        cache: "no-store",
      });
      const data = await readBody(res);
      if (res.status === 403) {
        setActionError("You are not signed in as an operator.");
        return;
      }
      if (!res.ok) {
        setActionError(data?.error || `That did not work (HTTP ${res.status}).`);
        return;
      }
      setPending(null);
      setActionNotice(
        choice.kind === "publish"
          ? `Version ${choice.release.version} is published. Screens can now see it, and install it only when someone taps Update firmware in that screen's Settings.`
          : `Version ${choice.release.version} is withdrawn. It is no longer offered; screens already running it stay on it, and an install already in progress can finish.`,
      );
      await load();
    } catch {
      setActionError("The request did not reach the server.");
    } finally {
      setActing(false);
    }
  }

  /**
   * End an install from the server side.
   *
   * This does not reach into the screen and stop it — nothing can, once the bytes
   * are on it. It ends the server's record as failed and releases the one-slot
   * reservation, so the screen can try again instead of being refused as
   * already-installing. Whatever the screen is actually running is unaffected,
   * and its next heartbeat reports that regardless of the ended attempt.
   */
  async function cancelInstall(attempt: ActiveAttempt) {
    if (acting) return;
    setActing(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await fetch("/api/admin/firmware/ota", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", attemptId: attempt.id }),
        cache: "no-store",
      });
      const data = await readBody(res);
      if (res.status === 403) {
        setActionError("You are not signed in as an operator.");
        return;
      }
      if (!res.ok) {
        setActionError(data?.error || `The install could not be cancelled (HTTP ${res.status}).`);
        return;
      }
      setCancelling(null);
      setActionNotice(
        `${attempt.deviceName}'s install of ${attempt.version} is marked failed and no longer holds the install slot. The screen keeps whatever it is running and will report that on its next check-in.`,
      );
      await load();
    } catch {
      setActionError("The request did not reach the server.");
    } finally {
      setActing(false);
    }
  }

  const published = catalog?.published ?? null;

  return (
    <section id="shared-firmware" style={{ marginTop: "1.5rem", paddingTop: "1.25rem", borderTop: "1px solid var(--color-border)" }}>
      <h3 style={{ marginTop: 0 }}>Shared firmware</h3>
      <p style={{ color: "var(--color-muted)", fontSize: "0.9rem", marginTop: "-0.25rem" }}>
        One app-only image for every screen of this model. Uploading only registers it. Publishing makes it
        visible to all compatible screens; each screen installs it from its own Settings, and never on its
        own. Per-screen firmware controls below stay for USB recovery.
      </p>

      {unavailable && (
        <p id="ota-unavailable" style={{ color: "var(--color-muted)", fontSize: "0.9rem" }}>
          Shared firmware is not available on this server yet, so this panel cannot show or publish releases.
        </p>
      )}

      {loadError && (
        <p id="ota-load-error" role="alert" aria-live="assertive" style={{ color: "#ff4d4d", fontSize: "0.9rem" }}>
          {loadError}
        </p>
      )}

      {!unavailable && (
        <>
          <div id="ota-published" style={{ marginTop: "1rem", padding: "1rem", border: "1px solid var(--color-border)", borderRadius: "8px" }}>
            <strong style={{ fontSize: "0.95rem" }}>Published release</strong>
            {published ? (
              <>
                <dl className="db-ledger" style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
                  <div><dt>Version</dt><dd>{published.version}</dd></div>
                  <div><dt>Size</dt><dd>{sizeLabel(published.sizeBytes)}</dd></div>
                  <div><dt>Published</dt><dd>{when(published.publishedAt)}</dd></div>
                  <div><dt>Descriptor</dt><dd>{published.descriptorProject} · {published.descriptorVersion}</dd></div>
                </dl>
                <div style={{ marginTop: "0.6rem", fontSize: "0.8rem" }}>
                  <span style={{ color: "var(--color-muted)" }}>SHA-256 </span>
                  <code
                    id="ota-published-sha"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere", wordBreak: "break-all" }}
                  >
                    {published.sha256}
                  </code>
                </div>
                <p style={{ color: "var(--color-muted)", fontSize: "0.8rem", marginTop: "0.5rem" }}>
                  Being published does not mean every screen has it. Check the screen rows below for what each
                  one has actually reported.
                </p>
              </>
            ) : (
              <p id="ota-none-published" style={{ color: "var(--color-muted)", fontSize: "0.875rem", marginTop: "0.5rem" }}>
                No release is published. Registered versions are not offered to any screen until one is published.
              </p>
            )}
          </div>

          <form onSubmit={uploadRelease} style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div>
              <label htmlFor="ota-version" className="admin-label">Release version</label>
              <input
                id="ota-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="e.g. 1.15.0"
                autoComplete="off"
                disabled={uploading}
                style={{ width: "100%", padding: "0.65rem 0.85rem", borderRadius: "8px", border: "1px solid var(--color-border)", background: "var(--color-bg)", color: "var(--color-text)" }}
              />
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                Must match the version compiled into the image. The server refuses a mismatch rather than
                registering an image a screen would report as a different release.
              </span>
            </div>
            <div>
              <label htmlFor="ota-file" className="admin-label">App-only image</label>
              <input
                ref={fileRef}
                id="ota-file"
                type="file"
                accept=".bin"
                disabled={uploading}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                style={{ color: "var(--color-text)", fontSize: "0.9rem" }}
              />
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", marginTop: "0.3rem" }}>
                Upload <code>firmware.ota.bin</code> — the app image that starts at the application, not the
                merged factory image used over USB. Validation happens before anything is stored.
              </span>
            </div>
            <button
              id="btn-ota-upload"
              className="primary-btn"
              type="submit"
              disabled={uploading || !file}
              style={{ padding: "0.65rem 1.25rem", fontSize: "0.95rem", width: "auto", alignSelf: "flex-start" }}
            >
              {uploading ? "Uploading and validating…" : "Upload release"}
            </button>
          </form>

          <div aria-live="polite" id="ota-upload-notice" style={{ minHeight: "1.2rem", marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--color-accent-warm)" }}>
            {uploadNotice}
          </div>
          <p role="alert" aria-live="assertive" id="ota-upload-error" style={{ color: "#ff4d4d", fontSize: "0.85rem", marginTop: "0.25rem" }}>
            {uploadError}
          </p>
        </>
      )}

      <div aria-live="polite" id="ota-action-notice" style={{ minHeight: "1.2rem", marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--color-accent-warm)" }}>
        {actionNotice}
      </div>
      <p role="alert" aria-live="assertive" id="ota-action-error" style={{ color: "#ff4d4d", fontSize: "0.85rem", marginTop: "0.25rem" }}>
        {actionError}
      </p>

      {catalog && catalog.activeAttempts.length > 0 && (
        <div id="ota-active" style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--color-muted)" }}>
          <strong style={{ color: "var(--color-text)" }}>Installing now</strong>
          <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
            {catalog.activeAttempts.map((a) => (
              <li key={a.id}>
                {a.deviceName} — {phaseLabel(a.phase)} {a.version}, last reported {when(a.updatedAt)}
                {a.errorCode ? ` (${a.errorCode})` : ""}
                {cancelling === a.id ? (
                  <span style={{ marginLeft: "0.5rem" }}>
                    <button
                      id={`btn-ota-cancel-attempt-${a.id}`}
                      className="primary-btn"
                      type="button"
                      disabled={acting}
                      onClick={() => void cancelInstall(a)}
                      style={{ padding: "0.25rem 0.7rem", fontSize: "0.8rem", width: "auto" }}
                    >
                      {acting ? "Cancelling…" : `End this install of ${a.version}`}
                    </button>{" "}
                    <button
                      type="button"
                      disabled={acting}
                      onClick={() => setCancelling(null)}
                      style={{ padding: "0.25rem 0.7rem", fontSize: "0.8rem", width: "auto" }}
                    >
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button
                    id={`btn-ota-arm-cancel-${a.id}`}
                    type="button"
                    disabled={acting}
                    onClick={() => { setActionError(null); setCancelling(a.id); }}
                    style={{ marginLeft: "0.5rem", padding: "0.25rem 0.7rem", fontSize: "0.8rem", width: "auto" }}
                  >
                    Cancel…
                  </button>
                )}
              </li>
            ))}
          </ul>
          <span>
            Server-reported state, not live download progress. Cancelling stops the server offering bytes and frees
            the screen to try again; it cannot reach back into a screen that has already installed.
          </span>
        </div>
      )}

      {catalog && (
        <div id="ota-releases" style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <strong style={{ fontSize: "0.95rem" }}>Registered releases</strong>
          {catalog.releases.length === 0 && (
            <p style={{ color: "var(--color-muted)", fontSize: "0.875rem", margin: 0 }}>None registered yet.</p>
          )}
          {catalog.releases.map((r) => {
            const isPublished = published?.id === r.id;
            const status = isPublished ? "published" : r.withdrawnAt ? "withdrawn" : "not published";
            const awaiting = pending?.release.id === r.id ? pending : null;
            return (
              <div key={r.id} id={`ota-release-${r.id}`} style={{ border: "1px solid var(--color-border)", borderRadius: "8px", padding: "0.75rem 0.9rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "baseline" }}>
                  <div style={{ fontSize: "0.9rem" }}>
                    <strong>Version {r.version}</strong>
                    <span style={{ marginLeft: "0.6rem", fontSize: "0.8rem", color: isPublished ? "#4e9fd4" : r.withdrawnAt ? "#b4432f" : "var(--color-muted)" }}>
                      {status}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    {!isPublished && !awaiting && (
                      <button
                        id={`btn-ota-publish-${r.id}`}
                        className="primary-btn"
                        type="button"
                        disabled={acting || uploading}
                        onClick={() => { setActionError(null); setPending({ kind: "publish", release: r }); }}
                        style={{ padding: "0.4rem 0.9rem", fontSize: "0.85rem", width: "auto" }}
                      >
                        Publish
                      </button>
                    )}
                    {isPublished && !awaiting && (
                      <button
                        id={`btn-ota-withdraw-${r.id}`}
                        className="primary-btn"
                        type="button"
                        disabled={acting || uploading}
                        onClick={() => { setActionError(null); setPending({ kind: "withdraw", release: r }); }}
                        style={{ padding: "0.4rem 0.9rem", fontSize: "0.85rem", width: "auto" }}
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: "0.4rem", fontSize: "0.78rem", color: "var(--color-muted)" }}>
                  <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                    SHA-256 {r.sha256}
                  </code>
                  <div style={{ marginTop: "0.2rem" }}>
                    {sizeLabel(r.sizeBytes)} · registered {when(r.createdAt)} · {r.attemptCount} installation
                    {r.attemptCount === 1 ? " attempt" : " attempts"}
                  </div>
                </div>

                {awaiting && (
                  <div
                    id={`ota-confirm-${r.id}`}
                    role="group"
                    aria-label={`Confirm ${awaiting.kind} of version ${r.version}`}
                    style={{ marginTop: "0.6rem", padding: "0.7rem 0.8rem", border: "1px solid var(--color-accent-warm)", borderRadius: "8px", fontSize: "0.85rem" }}
                  >
                    <p style={{ margin: 0 }}>
                      {awaiting.kind === "publish"
                        ? `Publish ${r.version} to ${
                            targetCount === undefined
                              ? "every compatible screen"
                              : `${targetCount} registered screen${targetCount === 1 ? "" : "s"}`
                          }? It becomes visible immediately, but no screen installs it until someone taps Update firmware in that screen's Settings.`
                        : `Withdraw ${r.version}? It stops being offered. The image and its record stay on the server; a screen already installing it can finish, a screen already running it stays on it, and bytes already downloaded cannot be recalled.`}
                    </p>
                    <p style={{ margin: "0.35rem 0 0", color: "var(--color-muted)", fontSize: "0.78rem" }}>
                      <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                        {shortSha(r.sha256)}
                      </code>
                    </p>
                    <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.6rem" }}>
                      <button
                        id={`btn-ota-confirm-${r.id}`}
                        className="primary-btn"
                        type="button"
                        disabled={acting}
                        onClick={() => void confirmAction()}
                        style={{ padding: "0.4rem 0.9rem", fontSize: "0.85rem", width: "auto" }}
                      >
                        {acting ? "Working…" : awaiting.kind === "publish" ? `Publish ${r.version}` : `Withdraw ${r.version}`}
                      </button>
                      <button
                        id={`btn-ota-cancel-${r.id}`}
                        className="primary-btn"
                        type="button"
                        disabled={acting}
                        onClick={() => setPending(null)}
                        style={{ padding: "0.4rem 0.9rem", fontSize: "0.85rem", width: "auto" }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {loading && !catalog && (
        <p style={{ color: "var(--color-muted)", fontSize: "0.875rem", marginTop: "0.75rem" }}>Loading releases…</p>
      )}
    </section>
  );
}
