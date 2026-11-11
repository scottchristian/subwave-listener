"use client";

import React from "react";

/**
 * Last line of defence for a render crash.
 *
 * Without this, any error thrown while rendering leaves the document empty, and
 * the browser substitutes its own error page — which reads as "the site is
 * down", sends people to the wrong place entirely, and hides the one piece of
 * information that would fix it. A production React error is a minified number
 * ("Minified React error #310"), so the component stack below is often the only
 * account of where it came from.
 *
 * So: catch it, show the listener something honest, and send the stack to the
 * station's own log so a crash can be diagnosed from the server without asking
 * anyone to open a developer console.
 *
 * PRIVACY: this reports the component stack and the error message, nothing
 * else. No props, no session, no track metadata, no account details — the same
 * rule the rest of the app keeps about what may reach a log while signed out.
 */

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class CaptureBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const componentStack = typeof info?.componentStack === "string" ? info.componentStack : "";
    // Best-effort and deliberately un-awaited: a reporting failure must never
    // become a second failure, and sendBeacon survives the navigation a reload
    // would otherwise interrupt.
    try {
      const payload = JSON.stringify({
        message: String(error?.message ?? error),
        name: String(error?.name ?? "Error"),
        componentStack: componentStack.slice(0, 4000),
        at: new Date().toISOString(),
      });
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/client-error", new Blob([payload], { type: "application/json" }));
      } else {
        void fetch("/api/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      }
    } catch {
      // Reporting is best-effort; the fallback below is the part that matters.
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="container centered-column" style={{ justifyContent: "center" }}>
        <div className="card" style={{ maxWidth: "480px" }}>
          <h1 style={{ fontSize: "1.4rem", margin: "0 0 1rem" }}>Please wait</h1>
          <p className="about-text" style={{ marginBottom: "2rem" }}>
            Something went wrong drawing this page. Reload to try again — if it keeps happening, the station has
            been sent a note about it.
          </p>
          <button
            id="btn-crash-reload"
            className="primary-btn"
            style={{ width: "auto" }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }
}
