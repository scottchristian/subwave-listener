"use client";

import { useState } from "react";

export type ScheduleHostPick = {
  name: string;
  avatar: string;
  role: string;
  tagline?: string;
  context?: string;
};

const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmtHour = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;

/**
 * The week's schedule, one day at a time. Days are views over the repeating
 * weekly grid (keyed 0=Sunday like the runway), so any offset works — arrows
 * walk days, opening always lands on the station's today. Tapping a face
 * opens that host's character card via onHost.
 */
export default function SchedulePanel({
  scheduleData,
  resolveAvatar,
  onHost,
  onClose,
}: {
  scheduleData: any;
  resolveAvatar: (path: string) => string;
  onHost: (pick: ScheduleHostPick) => void;
  onClose: () => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);

  const tz = scheduleData?.timezone;
  const grid = scheduleData?.schedule;
  const shows = scheduleData?.shows as any[] | undefined;
  const personas = scheduleData?.personas as any[] | undefined;

  const renderUnavailable = (why: string) => (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Shows</h2>
        <button id="btn-close-schedule" onClick={onClose} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
      </div>
      <p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>{why}</p>
    </div>
  );

  if (!grid || !shows || !tz) {
    return (
      <div id="schedule-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "560px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
        {renderUnavailable("Schedule unavailable right now — check back shortly.")}
      </div>
    );
  }

  let dayLabel = "";
  let dayIdx = -1;
  try {
    const base = new Date(Date.now() + dayOffset * 86400000);
    const short = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short" }).format(base);
    dayIdx = DAY_KEYS.indexOf(short);
    dayLabel =
      new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", day: "numeric", month: "short" }).format(base) +
      (dayOffset === 0 ? " (today)" : "");
  } catch {
    return (
      <div id="schedule-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "560px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
        {renderUnavailable("Schedule unavailable right now — check back shortly.")}
      </div>
    );
  }

  const row: (string | null)[] = dayIdx >= 0 && Array.isArray(grid[String(dayIdx)]) ? grid[String(dayIdx)] : [];
  const personaById = (id: string) => (personas as any[])?.find((p: any) => p.id === id) || null;
  const showById = (id: string) => (shows as any[]).find((s: any) => s.id === id) || null;

  // Group consecutive same-show hours into slots.
  const slots: { showId: string | null; from: number; to: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const id = h < row.length ? row[h] : null;
    const last = slots[slots.length - 1];
    if (last && last.showId === id) last.to = h + 1;
    else slots.push({ showId: id, from: h, to: h + 1 });
  }

  const arrowBtn = {
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    width: "2.25rem",
    height: "2.25rem",
    fontSize: "1.1rem",
    cursor: "pointer",
    flexShrink: 0,
  } as const;

  return (
    <div id="schedule-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "560px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Shows</h2>
          <button id="btn-close-schedule" onClick={onClose} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1rem" }}>
          <button id="btn-schedule-prev-day" type="button" aria-label="Previous day" onClick={() => setDayOffset((o) => o - 1)} style={arrowBtn}>
            ‹
          </button>
          <div id="schedule-day-label" style={{ fontSize: "1rem", fontWeight: 600, textAlign: "center" }}>{dayLabel}</div>
          <button id="btn-schedule-next-day" type="button" aria-label="Next day" onClick={() => setDayOffset((o) => o + 1)} style={arrowBtn}>
            ›
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {slots.map((slot, i) => {
            const show = slot.showId ? showById(slot.showId) : null;
            if (!show) {
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.75rem", borderRadius: "8px", background: "rgba(255,255,255,0.03)" }}>
                  <span style={{ fontSize: "0.85rem", color: "var(--color-muted)", minWidth: "6.5rem" }}>
                    {fmtHour(slot.from)} – {fmtHour(slot.to)}
                  </span>
                  <span style={{ fontSize: "0.95rem", color: "var(--color-muted)" }}>Auto DJ</span>
                </div>
              );
            }
            const hostIds = [show.personaId, ...((show.guestPersonaIds as string[]) || [])].filter(Boolean);
            const hosts = hostIds
              .map((id: string) => personaById(id))
              .filter((p: any) => p && p.name);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.75rem", borderRadius: "8px", background: "rgba(255,255,255,0.05)" }}>
                <span style={{ fontSize: "0.85rem", color: "var(--color-muted)", minWidth: "6.5rem" }}>
                  {fmtHour(slot.from)} – {fmtHour(slot.to)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: "0.95rem", fontWeight: 600 }}>{show.name}</span>
                  {hosts.length > 0 && (
                    <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                      {hosts.map((p: any, j: number) => (
                        <button
                          key={p.id || j}
                          type="button"
                          onClick={() =>
                            onHost({
                              name: p.name,
                              avatar: resolveAvatar(p.avatar),
                              role: p.id === show.personaId ? "Host" : "Guest",
                              tagline: p.tagline,
                              context: `on ${show.name}`,
                            })
                          }
                          aria-label={`About ${p.name}`}
                          title={`About ${p.name}`}
                          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
                        >
                          {p.avatar ? (
                            <img src={resolveAvatar(p.avatar)} alt="" aria-hidden="true" style={{ width: "28px", height: "28px", borderRadius: "50%", objectFit: "cover" }} />
                          ) : null}
                          <span style={{ fontSize: "0.85rem", color: "var(--color-muted)", borderBottom: "1px dotted rgba(255,255,255,0.35)", paddingBottom: "1px" }}>
                            {p.name}
                          </span>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
