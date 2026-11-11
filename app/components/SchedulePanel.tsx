"use client";

import { useState } from "react";
import { runForDay } from "@/lib/schedule-run";

export type ScheduleHostPick = {
  name: string;
  avatar: string;
  role: string;
  tagline?: string;
  context?: string;
};

const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Slot hours in the operator's face: 19:00, or 7 PM. Midnight end reads 24:00 / 12 AM. */
const fmtHour = (h: number, hour12: boolean) => {
  if (!hour12) return h === 24 ? "24:00" : `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
  const wrapped = ((h % 24) + 24) % 24;
  if (h === 24) return "12 AM";
  if (wrapped === 0) return "12 AM";
  if (wrapped === 12) return "12 PM";
  return wrapped < 12 ? `${wrapped} AM` : `${wrapped - 12} PM`;
};

/**
 * The week's schedule, one day — or one identical run of days — at a time.
 * Days are views over the repeating weekly grid (keyed 0=Sunday), so any
 * offset works. Consecutive days with the same lineup merge into one view
 * ("Monday → Thursday"); arrows jump run to run, opening lands on the run
 * holding the station's today. Tapping a show accordions its presenters;
 * tapping a presenter opens their character card via onHost.
 */
export default function SchedulePanel({
  scheduleData,
  hour12,
  resolveAvatar,
  onHost,
  onClose,
}: {
  scheduleData: any;
  hour12: boolean;
  resolveAvatar: (path: string) => string;
  onHost: (pick: ScheduleHostPick) => void;
  onClose: () => void;
}) {
  const [dayOffset, setDayOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const tz = scheduleData?.timezone;
  const grid = scheduleData?.schedule;
  const shows = scheduleData?.shows as any[] | undefined;
  const personas = scheduleData?.personas as any[] | undefined;

  const shell = (body: React.ReactNode) => (
    <div id="schedule-overlay-card" onClick={(e) => e.stopPropagation()} className="overlay-card-enter" style={{ maxWidth: "560px", width: "100%", margin: "0 auto", minHeight: "auto", padding: "0 0.5rem", position: "relative", zIndex: 2001 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ fontSize: "1.3rem", margin: 0 }}>Shows</h2>
          <button id="btn-close-schedule" onClick={onClose} className="primary-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", background: "rgba(255,255,255,0.1)", color: "#fff", width: "auto" }}>Close</button>
        </div>
        {body}
      </div>
    </div>
  );

  if (!grid || !shows || !tz) {
    return shell(<p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>Schedule unavailable right now — check back shortly.</p>);
  }

  // Station wall clock, for "today", the run anchor, and the on-air highlight.
  let nowDay = -1;
  let nowHour = -1;
  let nowMinute = -1;
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-AU", {
      timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
    }).formatToParts(new Date())) parts[p.type] = p.value;
    nowDay = DAY_KEYS.indexOf(parts.weekday);
    nowHour = parseInt(parts.hour, 10) % 24;
    nowMinute = parseInt(parts.minute, 10) % 60;
    if (nowDay < 0 || !Number.isFinite(nowHour) || !Number.isFinite(nowMinute)) return shell(<p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>Schedule unavailable right now — check back shortly.</p>);
  } catch {
    return shell(<p style={{ color: "var(--color-muted)", fontSize: "0.95rem", marginBottom: 0 }}>Schedule unavailable right now — check back shortly.</p>);
  }

  const sig = (d: number) => {
    const row = grid[String(((d % 7) + 7) % 7)];
    return Array.isArray(row) ? row.map((id) => id || "-").join(",") : "";
  };

  // The viewed date's weekday, then expand to the full identical run (up to
  // the whole week — a station running one lineup reads as a single view).
  const viewedDay = ((nowDay + dayOffset) % 7 + 7) % 7;
  const { start: runStart, end: runEnd } = runForDay(sig, viewedDay);
  const runDays: number[] = [];
  for (let d = runStart; d <= runEnd; d++) runDays.push(((d % 7) + 7) % 7);

  const row: (string | null)[] = Array.isArray(grid[String(viewedDay)]) ? grid[String(viewedDay)] : [];
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

  // Label: one day, or the whole identical run with its dates.
  const fmtDay = (ms: number, opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-AU", { timeZone: tz, ...opts }).format(new Date(ms));
    } catch {
      return "";
    }
  };
  const rangeLen = runEnd - runStart + 1;
  // Run edges as dates, counted from the viewed date.
  const viewedMs = Date.now() + dayOffset * 86400000;
  const startDateMs = viewedMs + (runStart - viewedDay) * 86400000;
  const endDateMs = viewedMs + (runEnd - viewedDay) * 86400000;
  const dayFloor = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const isToday = rangeLen === 1
    ? dayOffset === 0
    : dayFloor(Date.now()) >= dayFloor(startDateMs) && dayFloor(Date.now()) <= dayFloor(endDateMs);
  const dayLabel =
    rangeLen === 1
      ? `${fmtDay(viewedMs, { weekday: "long", day: "numeric", month: "short" })}${dayOffset === 0 ? " (today)" : ""}`
      : `${DAY_NAMES[runDays[0]]} → ${DAY_NAMES[runDays[runDays.length - 1]]}${isToday ? " (today)" : ""}`;
  const dateSub =
    rangeLen === 1
      ? ""
      : `${fmtDay(startDateMs, { day: "numeric", month: "short" })} – ${fmtDay(endDateMs, { day: "numeric", month: "short" })} · same lineup`;

  // Jump to the adjacent run: one day past this run's edge, then snap to it.
  const gotoPrevRun = () => {
    const targetOffset = dayOffset + (runStart - viewedDay) - 1;
    setDayOffset(targetOffset);
    setExpanded(null);
  };
  const gotoNextRun = () => {
    const targetOffset = dayOffset + (runEnd - viewedDay) + 1;
    setDayOffset(targetOffset);
    setExpanded(null);
  };

  // The slot on air right now — highlighted only when viewing today.
  const liveSlot = (slot: { from: number; to: number }) => {
    if (dayOffset !== 0) return false;
    const nowMin = nowHour * 60 + nowMinute;
    return nowMin >= slot.from * 60 && nowMin < slot.to * 60;
  };

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
          <button id="btn-schedule-prev-day" type="button" aria-label="Previous days" onClick={gotoPrevRun} style={arrowBtn}>
            ‹
          </button>
          <div style={{ textAlign: "center" }}>
            <div id="schedule-day-label" style={{ fontSize: "1rem", fontWeight: 600 }}>{dayLabel}</div>
            {dateSub ? <div style={{ fontSize: "0.8rem", color: "var(--color-muted)" }}>{dateSub}</div> : null}
          </div>
          <button id="btn-schedule-next-day" type="button" aria-label="Next days" onClick={gotoNextRun} style={arrowBtn}>
            ›
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {slots.map((slot, i) => {
            const show = slot.showId ? showById(slot.showId) : null;
            const live = liveSlot(slot);
            const key = `${viewedDay}-${slot.from}`;
            const open = expanded === key;
            if (!show) {
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.75rem", borderRadius: "8px", background: "rgba(255,255,255,0.03)" }}>
                  <span style={{ fontSize: "0.85rem", color: "var(--color-muted)", minWidth: "6.5rem" }}>
                    {fmtHour(slot.from, hour12)} – {fmtHour(slot.to, hour12)}
                  </span>
                  <span style={{ fontSize: "0.95rem", color: "var(--color-muted)" }}>Auto DJ</span>
                </div>
              );
            }
            const hostIds = [show.personaId, ...((show.guestPersonaIds as string[]) || [])].filter(Boolean);
            const hosts = hostIds
              .map((id: string) => personaById(id))
              .filter((p: any) => p && p.name);
            const hostNames = hosts.map((p: any) => p.name).join(", ");
            return (
              <div
                key={i}
                style={{
                  borderRadius: "8px",
                  background: live ? "rgba(78,159,212,0.14)" : "rgba(255,255,255,0.05)",
                  border: live ? "1px solid rgba(78,159,212,0.55)" : "1px solid transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : key)}
                  aria-expanded={open}
                  aria-label={`${show.name}, ${fmtHour(slot.from, hour12)} to ${fmtHour(slot.to, hour12)}${live ? ", on air now" : ""}`}
                  style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%", padding: "0.6rem 0.75rem", background: "none", border: "none", cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
                >
                  <span style={{ fontSize: "0.85rem", color: "var(--color-muted)", minWidth: "6.5rem" }}>
                    {fmtHour(slot.from, hour12)} – {fmtHour(slot.to, hour12)}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "0.95rem", fontWeight: 700 }}>
                      {live ? "● " : ""}{show.name}
                    </span>
                    {hostNames ? (
                      <span style={{ display: "block", fontSize: "0.85rem", color: "#ff4d4d" }}>{hostNames}</span>
                    ) : null}
                  </span>
                  <span aria-hidden="true" style={{ color: "var(--color-muted)", transition: "transform 0.2s ease", transform: open ? "rotate(180deg)" : "none" }}>
                    ▾
                  </span>
                </button>
                {open && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", padding: "0.25rem 0.75rem 0.75rem 7.25rem" }}>
                    {hosts.length === 0 && (
                      <span style={{ fontSize: "0.85rem", color: "var(--color-muted)" }}>Host details coming soon.</span>
                    )}
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
                        style={{ display: "flex", alignItems: "center", gap: "0.75rem", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}
                      >
                        {p.avatar ? (
                          <img src={resolveAvatar(p.avatar)} alt="" aria-hidden="true" style={{ width: "44px", height: "44px", borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                        ) : null}
                        <span>
                          <span style={{ display: "block", fontSize: "0.9rem", fontWeight: 600 }}>{p.name}</span>
                          <span style={{ display: "block", fontSize: "0.8rem", color: "var(--color-muted)" }}>
                            {p.id === show.personaId ? "Host" : "Guest"}{p.tagline ? ` — ${p.tagline}` : ""}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
