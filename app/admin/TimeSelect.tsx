"use client";

import { useState, useEffect } from "react";
import { splitTimeOfDay, joinTimeParts, formatTimeOfDay } from "@/lib/update-time";

/**
 * A time picker with an explicit face: 12-hour (hour + minute + AM/PM) or
 * 24-hour (hour + minute). Native <input type="time"> follows the device
 * locale with no way to choose, which left operators guessing which face they
 * were looking at — this one always says which.
 *
 * Values in and out are "HH:MM" 24-hour, matching the settings store. Steps of
 * 15 minutes; a stored value off that grid is kept as an extra option rather
 * than silently rounded away.
 */
const MINUTES = ["00", "15", "30", "45"];

export default function TimeSelect({
  id,
  label,
  value,
  onChange,
  hour12,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hour12: boolean;
}) {
  const hours = hour12
    ? Array.from({ length: 12 }, (_, i) => String(i + 1))
    : Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

  // Local state for partial selection — avoids controlled-component reset
  // when the parent value is incomplete.
  const [localHour, setLocalHour] = useState("");
  const [localMinute, setLocalMinute] = useState("");
  const [localAp, setLocalAp] = useState<"AM" | "PM" | "">("");

  // Sync local state from parent value when it changes (e.g. on load).
  useEffect(() => {
    const p = splitTimeOfDay(value);
    if (p) {
      const h = hour12
        ? String(p.h24 % 12 === 0 ? 12 : p.h24 % 12)
        : String(p.h24).padStart(2, "0");
      const m = String(p.m).padStart(2, "0");
      const ap = hour12 ? (p.h24 < 12 ? "AM" : "PM") : "";
      setLocalHour(h);
      setLocalMinute(m);
      setLocalAp(ap);
    } else {
      setLocalHour("");
      setLocalMinute("");
      setLocalAp("");
    }
  }, [value, hour12]);

  // When all required parts are present, emit the combined value.
  const maybeEmit = () => {
    const next = joinTimeParts(localHour, localMinute, hour12 ? localAp || null : null);
    if (next !== null) onChange(next);
  };

  const handleHourChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalHour(e.target.value);
    // minute may already be set in local state
    maybeEmit();
  };
  const handleMinuteChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalMinute(e.target.value);
    maybeEmit();
  };
  const handleApClick = (ap: "AM" | "PM") => {
    setLocalAp(ap);
    maybeEmit();
  };

  const minutes =
    localMinute && !MINUTES.includes(localMinute) ? [localMinute, ...MINUTES].sort() : MINUTES;

  const selectStyle = {
    background: "var(--color-surface)",
    color: "var(--color-text)",
    border: "1px solid var(--color-border)",
    borderRadius: "8px",
    padding: "0.55rem 0.6rem",
    fontSize: "1rem",
  } as const;

  // For display: show the formatted time next to the picker when complete.
  const displayValue = localHour && localMinute
    ? formatTimeOfDay(
        joinTimeParts(localHour, localMinute, hour12 ? localAp || null : null) || "",
        hour12
      )
    : null;

  return (
    <label style={{ fontSize: "0.9rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <select
          id={`${id}-hour`}
          aria-label={`${label} hour`}
          value={localHour}
          onChange={handleHourChange}
          style={selectStyle}
        >
          <option value="">--</option>
          {hours.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span aria-hidden="true" style={{ fontWeight: 700 }}>
          :
        </span>
        <select
          id={`${id}-minute`}
          aria-label={`${label} minute`}
          value={localMinute}
          onChange={handleMinuteChange}
          style={selectStyle}
        >
          <option value="">--</option>
          {minutes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {hour12 ? (
          <span role="group" aria-label={`${label} AM or PM`} style={{ display: "inline-flex", borderRadius: "8px", overflow: "hidden", border: "1px solid var(--color-border)" }}>
            {(["AM", "PM"] as const).map((ap) => (
              <button
                key={ap}
                type="button"
                aria-pressed={localAp === ap}
                onClick={() => handleApClick(ap)}
                style={{
                  padding: "0.55rem 0.8rem",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  border: "none",
                  cursor: "pointer",
                  background: localAp === ap ? "var(--color-accent)" : "transparent",
                  color: localAp === ap ? "#fff" : "var(--color-muted)",
                }}
              >
                {ap}
              </button>
            ))}
          </span>
        ) : null}
        {displayValue && (
          <span style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginLeft: "0.5rem" }}>
            {displayValue}
          </span>
        )}
      </span>
    </label>
  );
}