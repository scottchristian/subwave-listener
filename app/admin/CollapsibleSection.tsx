"use client";

import { useState, type ReactNode } from "react";

/**
 * A settings panel that is a heading until you ask for it.
 *
 * Station and Services each stack several panels of live settings. Showing every
 * control at once meant a screen of toggles and inputs where it was easy to flip
 * something you were not looking at — and, on a station where saving some of
 * these restarts or rebuilds the player, expensive to notice afterwards. So each
 * panel opens collapsed to its heading and a sentence about what it does, and
 * the controls only exist once you have deliberately opened that one.
 *
 * `id` goes on the heading, not the wrapper, so it addresses the section by the
 * thing a reader can actually see. The expansion animates 1fr -> 0fr on a grid,
 * which is the same technique the Liked Songs rows and the Services toggles
 * already use, so height changes read the same everywhere in the app.
 */
export default function CollapsibleSection({
  id,
  title,
  summary,
  children,
  hidden,
}: {
  id: string;
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  /** Tab-level visibility, applied to the wrapper so the panel is truly gone. */
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = `${id}-body`;

  return (
    <section className="card" style={hidden ? { display: "none" } : undefined}>
      <h2 id={id} className="admin-collapse-head">
        <button
          // Built from the section id so every panel's toggle is addressable
          // (`tab-x-body`-style names already used elsewhere in the admin).
          id={`${id}-toggle`}
          type="button"
          className="admin-collapse-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="admin-collapse-text">
            {/* No font-size or weight here on purpose: the span inherits from the
                h2, so a collapsed heading is pixel-identical to the old static
                one. */}
            <span className="admin-collapse-title">{title}</span>
            {summary ? <span className="admin-collapse-summary">{summary}</span> : null}
          </span>
          <span className="admin-collapse-chevron" aria-hidden="true">›</span>
        </button>
      </h2>

      <div
        id={bodyId}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 0.25s ease",
          overflow: "hidden",
        }}
      >
        <div style={{ overflow: "hidden", minHeight: 0 }}>
          <div className="admin-collapse-inner">{children}</div>
        </div>
      </div>
    </section>
  );
}