"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StationStatsResponse } from "@/lib/station-stats-types";
import styles from "./StationStatsPanel.module.css";

const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CURRENT_MAX_AGE_MS = 90_000;

type LoadState = {
  data: StationStatsResponse | null;
  loading: boolean;
  failure: string | null;
};
type User = { id: string; name?: string | null; nickname?: string | null };
type TimelineMetric = "listeners" | "signedIn" | "listening" | "devicesOnline";
const TIMELINE_METRICS: Record<TimelineMetric, { title: string; label: string; unit: string; description: string }> = {
  listeners: { title: "Station listener timeline", label: "Station listeners", unit: "concurrent station listeners", description: "Station-wide listeners, separate from authenticated app users and devices." },
  signedIn: { title: "Signed-in user timeline", label: "Signed-in users", unit: "signed-in users", description: "Authenticated active app presence, not persistent login cookies. Each user counts once across tabs." },
  listening: { title: "App listener timeline", label: "App listeners", unit: "app listeners", description: "Authenticated users receiving actual forwarded audio. Each user counts once across tabs." },
  devicesOnline: { title: "Device online timeline", label: "Devices online", unit: "devices online", description: "Devices with a heartbeat within 90 seconds; not a TCP connection or streaming count." },
};
type Interval = {
  start: number;
  end: number;
  value: number | null;
  onAir: boolean | null;
};

// Station dates are calendar keys, not instants in the browser's timezone.
function shiftDate(value: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) return null;
  day.setUTCDate(day.getUTCDate() + days);
  const result = day.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) && result >= "0001-01-01" ? result : null;
}

function userLabel(user: User | undefined): string {
  // A profile can itself contain an email-shaped name: never expose it here.
  return [user?.nickname, user?.name].find(value => value?.trim() && !value.includes("@") && value.trim() !== user?.id)?.trim() || "Former account";
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(seconds: number | null): string {
  if (seconds === null) return "Unknown";
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function count(value: number | null, decimals = 0): string {
  return value === null ? "Unknown" : value.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function sampledCount(value: number | null, unavailable: boolean, live: boolean): string {
  // No recorded historical sample is Unknown, even if collection reports an error.
  return unavailable && (live || value !== null) ? "Unavailable" : count(value);
}

function stationZone(value: string | null) {
  if (value) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return { zone: value, label: `Station timezone: ${value}` };
    } catch { /* Never silently format station timestamps in the browser's timezone. */ }
  }
  return { zone: "UTC", label: "Station timezone unavailable; times shown in UTC" };
}

function timeLabel(value: string | number | null, zone: string, full = false): string {
  const at = typeof value === "number" ? value : timestamp(value);
  if (at === null) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(full ? { year: "numeric", month: "short", day: "numeric", second: "2-digit", timeZoneName: "shortOffset" } as const : {}),
  }).format(at);
}

function airStatus(onAir: boolean | null): string {
  return onAir === null ? "On-air status unknown" : onAir ? "On air" : "Off air";
}

function coverage(observed: number, elapsed: number): string {
  const percentage = elapsed > 0 ? ` (${Math.min(100, Math.floor(observed / elapsed * 100))}%)` : "";
  return `${duration(observed)} of ${duration(elapsed)} elapsed${percentage}`;
}

function buildTimeline(data: StationStatsResponse, metric: TimelineMetric) {
  const start = timestamp(data.dayStart);
  const dayEnd = timestamp(data.dayEnd);
  const generated = timestamp(data.generatedAt);
  if (start === null || dayEnd === null || generated === null) return null;
  const end = Math.min(dayEnd, generated);
  if (end <= start) return null;

  // Each sample covers only its reported interval. Fill omitted intervals with
  // unknowns rather than joining the last known count across a collection gap.
  const samples = data.timeline.flatMap(sample => {
    const at = timestamp(sample.at);
    const until = timestamp(sample.endAt);
    return at === null || until === null || until <= at ? [] : [{
      start: Math.max(start, at), end: Math.min(end, until),
      value: sample[metric] ?? null, onAir: sample.onAir,
    }];
  }).sort((a, b) => a.start - b.start);
  const intervals: Interval[] = [];
  let cursor = start;
  for (const sample of samples) {
    if (sample.end <= cursor || sample.start >= end) continue;
    if (sample.start > cursor) {
      intervals.push({ start: cursor, end: sample.start, value: null, onAir: null });
    }
    intervals.push({ ...sample, start: Math.max(cursor, sample.start) });
    cursor = sample.end;
  }
  if (cursor < end) intervals.push({ start: cursor, end, value: null, onAir: null });
  return { start, end, intervals };
}

function ListenerTimeline({ data, zone, metric }: { data: StationStatsResponse; zone: string; metric: TimelineMetric }) {
  const chart = useMemo(() => buildTimeline(data, metric), [data, metric]);
  const info = TIMELINE_METRICS[metric];
  const [selectedSecond, setSelectedSecond] = useState<number | null>(null);
  if (!chart) {
    return <p id="station-stats-timeline-empty" className={styles.note}>No elapsed timeline is available yet. Station day boundaries and sampled intervals are needed.</p>;
  }

  const { start, end, intervals } = chart;
  const maxSecond = Math.max(0, Math.ceil((end - start) / 1000) - 1);
  const second = Math.min(selectedSecond ?? maxSecond, maxSecond);
  const selectedAt = Math.min(start + second * 1000, end - 1);
  const selected = intervals.find(interval => interval.start <= selectedAt && interval.end > selectedAt);
  const maximum = intervals.reduce((max, interval) => Math.max(max, interval.value ?? 0), 1);
  const x = (at: number) => (at - start) / (end - start) * 800;
  const y = (listeners: number) => 148 - listeners / maximum * 136;
  const valueDescription = selected?.value == null ? `${info.label} unknown` : `${count(selected.value)} ${info.unit}`;
  const description = `${timeLabel(selectedAt, zone, true)}: ${valueDescription}.${metric === "listeners" ? ` ${airStatus(selected?.onAir ?? null)}.` : ""}`;
  const hasSamples = intervals.some(interval => interval.value !== null);

  return (
    <div id="section-station-stats-timeline" className={styles.timeline}>
      {!hasSamples && <p id="station-stats-no-listener-samples" className={styles.note}>No {info.label.toLowerCase()} samples for this station day. The shaded area is unknown, not zero.</p>}
      <div className={styles.plotRow}>
        <div id="station-stats-y-axis" className={styles.yAxis} aria-hidden="true"><span>{count(maximum)}</span><span>0</span></div>
        <svg
          id="station-stats-chart"
          className={styles.chart}
          viewBox="0 0 800 160"
          preserveAspectRatio="none"
          role="img"
          aria-labelledby="station-stats-chart-title station-stats-chart-description"
        >
          <title id="station-stats-chart-title">{info.title} — {data.isToday ? "today" : data.date || "selected station day"}</title>
          <desc id="station-stats-chart-description">Sampled {info.label.toLowerCase()} from {timeLabel(start, zone)} to {timeLabel(end, zone)} in {zone}. Hatched areas are missing data, not zero. Use the time slider below to inspect each interval.</desc>
          <defs>
            <pattern id="station-stats-gap-pattern" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M-2 2L2 -2 M0 8L8 0 M6 10L10 6" stroke="var(--color-muted)" strokeOpacity="0.4" strokeWidth="1" />
            </pattern>
          </defs>
          <path d="M0 12H800 M0 148H800" stroke="var(--color-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {intervals.map((interval, index) => interval.value === null ? (
            <rect id={`station-stats-interval-${index}`} key={index} x={x(interval.start)} y="0" width={x(interval.end) - x(interval.start)} height="160" fill="url(#station-stats-gap-pattern)" />
          ) : (
            <path id={`station-stats-interval-${index}`} key={index} d={`M${x(interval.start)} ${y(interval.value)}H${x(interval.end)}`} fill="none" stroke="var(--color-accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          ))}
          <line id="station-stats-chart-cursor" x1={x(selectedAt)} x2={x(selectedAt)} y1="0" y2="160" stroke="var(--color-text)" strokeDasharray="4 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div id="station-stats-time-labels" className={styles.timeLabels} aria-hidden="true">
        <span>{timeLabel(start, zone)}</span><span>{timeLabel(start + (end - start) / 2, zone)}</span><span>{timeLabel(end, zone)}</span>
      </div>
      <p id="station-stats-chart-legend" className={styles.note}>Blue line: sampled {info.label.toLowerCase()}. Hatched gaps: missing data, not zero.</p>
      <label className={styles.inspectLabel} htmlFor="input-station-stats-time">Inspect a time ({zone})</label>
      <input
        id="input-station-stats-time"
        className={styles.timeInput}
        type="range"
        min="0"
        max={maxSecond}
        step="1"
        value={second}
        onChange={event => setSelectedSecond(Number(event.target.value))}
        aria-valuetext={description}
        aria-describedby="station-stats-inspect-help"
      />
      <p id="station-stats-inspect-help" className={styles.note}>Drag or use the arrow keys to inspect a time. Home and End jump to the start and end.</p>
      <output id="station-stats-inspection" htmlFor="input-station-stats-time" className={styles.inspection} aria-live="polite" aria-atomic="true">
        {description}
        {selected && <span className={styles.note}> Interval: {timeLabel(selected.start, zone, true)} to {timeLabel(selected.end, zone, true)}.</span>}
      </output>
    </div>
  );
}

export default function StationStatsPanel({ active, users }: { active: boolean; users: User[] }) {
  const [state, setState] = useState<LoadState>({ data: null, loading: true, failure: null });
  // null follows the live station day; an explicit date stays fixed at midnight.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selectedDateRef = useRef<string | null>(null);
  const [calendar, setCalendar] = useState<{ todayDate: string | null; timeZone: string | null; availableDates: string[] }>({ todayDate: null, timeZone: null, availableDates: [] });
  const calendarRef = useRef(calendar);
  const [metric, setMetric] = useState<TimelineMetric>("listeners");
  const refresh = useRef<() => void>(() => {});
  const accessFailure = useRef<string | null>(null);
  const userNames = useMemo(() => new Map(users.map(user => [user.id, userLabel(user)])), [users]);

  const selectDate = (date: string | null) => {
    if (date !== null && (!shiftDate(date, 0) || !calendar.todayDate || date > calendar.todayDate)) return;
    if (date === selectedDateRef.current) return;
    selectedDateRef.current = date;
    setState({ data: null, loading: active && !accessFailure.current, failure: accessFailure.current });
    setSelectedDate(date);
  };

  useEffect(() => {
    if (!active) {
      setState({ data: null, loading: false, failure: null });
      return;
    }
    let disposed = false;
    let controller: AbortController | null = null;
    let requestTimeout: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let freshnessTimeout: ReturnType<typeof setTimeout> | null = null;
    let dayTimeout: ReturnType<typeof setTimeout> | null = null;
    let day: { end: number; deadline: number } | null = null;
    let expiredDayEnd = -Infinity;
    let denied = accessFailure.current !== null;
    let liveDay = selectedDate === null || selectedDate === calendarRef.current.todayDate;
    const isCurrentSelection = () => !disposed && selectedDateRef.current === selectedDate;
    const setPolling = (enabled: boolean) => {
      if (poll !== null) clearInterval(poll);
      poll = enabled && !document.hidden && !denied
        ? setInterval(() => { void load(); }, REFRESH_MS) : null;
    };

    const clearSnapshotTimers = () => {
      if (freshnessTimeout !== null) clearTimeout(freshnessTimeout);
      if (dayTimeout !== null) clearTimeout(dayTimeout);
      freshnessTimeout = null;
      dayTimeout = null;
      day = null;
    };
    const cancelRequest = () => {
      if (requestTimeout !== null) clearTimeout(requestTimeout);
      requestTimeout = null;
      controller?.abort();
      controller = null;
    };
    const rollover = (end: number) => {
      if (!isCurrentSelection()) return;
      clearSnapshotTimers();
      if (selectedDate === null) expiredDayEnd = Math.max(expiredDayEnd, end);
      // Explicit dates become historical; only dynamic Today follows midnight.
      liveDay = selectedDate === null;
      setPolling(liveDay);
      cancelRequest();
      const nextDate = calendarRef.current.todayDate && shiftDate(calendarRef.current.todayDate, 1);
      if (nextDate) {
        calendarRef.current = { ...calendarRef.current, todayDate: nextDate };
        setCalendar(calendarRef.current);
      }
      setState(previous => ({ data: null, loading: !document.hidden && !denied, failure: denied ? accessFailure.current || previous.failure : null }));
      void load();
    };

    const load = async (manual = false) => {
      if (!isCurrentSelection() || document.hidden || controller || (denied && !manual)) return;
      denied = false;
      accessFailure.current = null;
      const request = new AbortController();
      controller = request;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, REQUEST_TIMEOUT_MS);
      requestTimeout = timeout;
      setState(previous => ({ ...previous, loading: true, failure: null }));
      try {
        const response = await fetch(`/api/admin/station-stats${selectedDate === null ? "" : `?date=${encodeURIComponent(selectedDate)}`}`, { cache: "no-store", signal: request.signal });
        if (!isCurrentSelection() || controller !== request) return;
        if (request.signal.aborted) throw new Error("Request aborted");
        if (!response.ok) {
          if (response.status === 403 || response.status === 401) {
            denied = true;
            setPolling(false);
            accessFailure.current = response.status === 403
              ? "Access denied (403). Station statistics require an admin account. Sign in with an admin account, then retry."
              : "Your session has expired (401). Sign in again, then retry.";
            throw new Error(accessFailure.current);
          }
          throw new Error(`Could not load station statistics (HTTP ${response.status}). Retry to request a new snapshot.`);
        }
        const data: StationStatsResponse = await response.json().catch(() => {
          throw new Error("The station statistics response could not be read. Retry to request a new snapshot.");
        });
        if (request.signal.aborted) throw new Error("Request aborted");
        if (!data?.current || !data?.today || !data?.activity?.current || !Array.isArray(data.activity.users) || !Array.isArray(data.timeline) || !Array.isArray(data.availableDates) || typeof data.isToday !== "boolean") {
          throw new Error("The station statistics response was incomplete. Retry to request a new snapshot.");
        }
        if (selectedDate !== null && data.date !== null && data.date !== selectedDate) {
          throw new Error("The snapshot did not match the selected station date. Retry to request it again.");
        }
        if (isCurrentSelection() && controller === request && !request.signal.aborted) {
          const receivedAt = performance.now();
          // A response may finish before an overdue midnight timer gets to run.
          if (day && receivedAt >= day.deadline) {
            rollover(day.end);
            return;
          }
          const generated = timestamp(data.generatedAt);
          const end = timestamp(data.dayEnd);
          const sampled = timestamp(data.current.at);
          if ((selectedDate === null && data.date !== null && !data.isToday) || (data.isToday && end !== null && (end <= expiredDayEnd || (generated !== null && end <= generated)))) {
            throw new Error("The station statistics snapshot belongs to an expired station day. Retry to request a new snapshot.");
          }
          // Use server-relative durations anchored to local receipt, not the
          // browser's wall clock, which may disagree with the station server.
          const freshFor = data.isToday && sampled !== null && generated !== null
            ? Math.max(0, sampled + CURRENT_MAX_AGE_MS - generated) : null;
          const nextDay = data.isToday && end !== null && generated !== null ? {
            end,
            deadline: Math.min(receivedAt + end - generated, day?.end === end ? day.deadline : Infinity),
          } : null;
          clearSnapshotTimers();
          const snapshot = { ...data, current: { ...data.current, stale: data.isToday && (data.current.stale || freshFor === 0) } };
          liveDay = selectedDate === null || data.isToday;
          setPolling(liveDay);
          calendarRef.current = { todayDate: data.todayDate, timeZone: data.timeZone, availableDates: data.availableDates };
          setCalendar(calendarRef.current);
          setState({ data: snapshot, loading: false, failure: null });
          if (!snapshot.current.stale && freshFor !== null) {
            freshnessTimeout = setTimeout(() => {
              freshnessTimeout = null;
              setState(previous => isCurrentSelection() && previous.data === snapshot
                ? { ...previous, data: { ...snapshot, current: { ...snapshot.current, stale: true } } }
                : previous);
            }, freshFor);
          }
          day = nextDay;
          if (nextDay) {
            dayTimeout = setTimeout(() => { rollover(nextDay.end); }, Math.max(0, nextDay.deadline - performance.now()));
          }
        }
      } catch (error) {
        if (isCurrentSelection() && controller === request && (!request.signal.aborted || timedOut)) {
          // An old success must not survive a failed refresh looking like live data.
          clearSnapshotTimers();
          setState({ data: null, loading: false, failure: timedOut
            ? "Station statistics timed out. Retry to request a new snapshot."
            : error instanceof Error && !(error instanceof TypeError) ? error.message : "Could not load station statistics. Check your connection and retry." });
        }
      } finally {
        clearTimeout(timeout);
        if (requestTimeout === timeout) requestTimeout = null;
        if (controller === request) {
          controller = null;
          if (isCurrentSelection()) setPolling(liveDay);
        }
      }
    };

    const pause = () => {
      if (poll !== null) clearInterval(poll);
      poll = null;
      clearSnapshotTimers();
      cancelRequest();
    };
    const onVisibility = () => {
      pause();
      // Clear hidden snapshots so resuming after midnight cannot display yesterday
      // as today while the replacement request is in flight.
      setState(previous => ({ data: null, loading: !document.hidden && !denied, failure: denied ? accessFailure.current || previous.failure : null }));
      if (!document.hidden) {
        void load();
        setPolling(liveDay);
      }
    };
    refresh.current = () => { void load(true); };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      disposed = true;
      pause();
      refresh.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, selectedDate]);

  const { data, loading, failure } = state;
  const { zone, label: zoneLabel } = stationZone(data?.timeZone ?? calendar.timeZone);
  const dateValue = selectedDate ?? calendar.todayDate ?? "";
  const previousDate = shiftDate(dateValue, -1);
  const nextDate = shiftDate(dateValue, 1);
  const sourceError = data?.error ?? null;
  const activityError = data?.activity.error ?? null;
  const stale = Boolean(data?.isToday && data.current.stale);
  const currentUnavailable = stale || sourceError !== null;
  const currentState = sourceError ? "error" : stale ? "stale" : data?.current.listeners == null ? "unknown" : data.isToday ? "live" : "recorded";
  const partial = data && (data.today.airtimeObservedSec < data.today.elapsedSec || data.today.listenerObservedSec < data.today.elapsedSec);
  const dayStart = timestamp(data?.dayStart ?? null);
  const activity = data?.activity;
  const activityUnavailable = stale || activityError !== null;
  const dayLabel = data?.isToday ? "today" : "this station day";
  const sampleLabel = data?.isToday ? "At latest sample" : "Last recorded";
  const metricInfo = TIMELINE_METRICS[metric];

  return (
    <section id="section-station-stats" className={`card ${styles.panel}`} hidden={!active} aria-labelledby="station-stats-title" aria-busy={loading}>
      <div className={styles.header}>
        <div>
          <h2 id="station-stats-title">Station statistics</h2>
          <p className={styles.note}>Station listeners, app activity and devices for one station day. The separate Now sections below remain live.</p>
        </div>
        <button id="btn-refresh-station-stats" type="button" className={`primary-btn ${styles.refresh}`} disabled={loading} onClick={() => refresh.current()}>
          {loading ? "Refreshing…" : failure || sourceError || activityError ? "Retry" : "Refresh"}
        </button>
      </div>
      <div id="station-stats-date-controls" className={styles.dateControls} role="group" aria-label="Station date">
        <button id="btn-station-stats-previous-day" type="button" className={styles.dateButton} disabled={!previousDate || !calendar.todayDate} onClick={() => previousDate && selectDate(previousDate)}>Previous day</button>
        <label className={styles.dateField} htmlFor="input-station-stats-date">
          Station date
          <input id="input-station-stats-date" className={styles.selectInput} type="date" min="0001-01-01" max={calendar.todayDate ?? undefined} value={dateValue} disabled={!calendar.todayDate} onChange={event => selectDate(event.target.value)} onInput={event => selectDate(event.currentTarget.value)} aria-describedby="station-stats-date-help" />
        </label>
        <button id="btn-station-stats-next-day" type="button" className={styles.dateButton} disabled={!nextDate || !calendar.todayDate || nextDate > calendar.todayDate} onClick={() => nextDate && selectDate(nextDate)}>Next day</button>
        <button id="btn-station-stats-today" type="button" className={styles.dateButton} aria-pressed={selectedDate === null} onClick={() => selectDate(null)}>Today</button>
      </div>
      <p id="station-stats-date-help" className={styles.note}>
        {zoneLabel}. {selectedDate === null ? "Today follows the station’s date automatically." : "Selected date stays fixed; choose Today to follow the live station day."}
        {calendar.todayDate && ` ${calendar.availableDates.length} recorded ${calendar.availableDates.length === 1 ? "date" : "dates"} available. Any past date can be selected; missing history is Unknown.`}
      </p>
      <p id="station-stats-status" className={styles.note} role="status">
        {loading ? data ? "Refreshing; showing the last sampled snapshot until the request completes." : "Loading station statistics…"
          : failure ? "No snapshot displayed because the latest request failed."
          : data ? data.isToday || selectedDate === null ? "Refreshes every 60 seconds while Stats is open and this tab is visible." : "Historical snapshot. Reloads on date selection or tab visibility; use Refresh to request it again."
          : "Updates paused while this tab is hidden."}
      </p>
      {failure && <p id="station-stats-error" className={styles.warning} role="alert">{failure}</p>}
      {data && (
        <div id="section-station-stats-content">
          <p id="station-stats-timezone" className={styles.day}>
            {data.isToday ? "Today" : "Selected station day"}{dayStart !== null ? ` (${new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: "medium" }).format(dayStart)})` : data.date ? ` (${data.date})` : " (station day unavailable)"}. {zoneLabel}.
          </p>
          <p className={styles.note}>Sampled estimates since collection began, not a reconstructed full-day history. Missing samples are unknown, never zero.</p>
          {sourceError && <p id="station-stats-source-error" className={styles.warning} role="alert">Station source error: {sourceError}. Available observations remain below; current listeners are unavailable. Retry to check again.</p>}
          <dl id="station-stats-metrics" className={styles.metrics}>
            <div id="station-stats-airtime" className={styles.metric}>
              <dt>{data.isToday ? "Today’s station airtime" : "Station airtime"}</dt>
              <dd id="station-stats-airtime-value" className={styles.value}>{duration(data.today.airtimeSec)}</dd>
              <dd className={styles.note}>Estimated time on air during observed intervals.</dd>
            </div>
            <div id="station-stats-current" className={styles.metric} data-state={currentState}>
              <dt>{data.isToday ? "Current listeners" : "Last recorded listeners"}</dt>
              <dd id="station-stats-current-value" className={styles.value}>{sampledCount(data.current.listeners, currentUnavailable, data.isToday)}</dd>
              <dd id="station-stats-current-status" className={styles.note}>
                {currentUnavailable
                  ? `${stale ? "Stale sample" : "Source error"}. Last reported count: ${count(data.current.listeners)}. Last status: ${airStatus(data.current.onAir).toLowerCase()}.`
                  : `${airStatus(data.current.onAir)}. ${data.isToday ? "Latest sampled count" : "Last recorded count for this station day"}, not app sessions.`}
                {data.current.at && ` Sample: ${timeLabel(data.current.at, zone, true)}.`}
              </dd>
            </div>
            <div id="station-stats-peak" className={styles.metric}>
              <dt>{data.isToday ? "Today’s peak listeners" : "Peak listeners"}</dt>
              <dd id="station-stats-peak-value" className={styles.value}>{count(data.today.peakListeners)}</dd>
              <dd className={styles.note}>Highest sampled concurrent count {dayLabel}.</dd>
            </div>
            <div id="station-stats-average" className={styles.metric}>
              <dt>Average concurrent listeners</dt>
              <dd id="station-stats-average-value" className={styles.value}>{count(data.today.averageListeners, 1)}</dd>
              <dd className={styles.note}>Time-weighted average across observed listener time {dayLabel}, not unique people.</dd>
            </div>
          </dl>
          <div id="station-stats-coverage" className={styles.coverage}>
            <h3 id="station-stats-coverage-title">{partial ? "Partial sample coverage" : "Sample coverage"} {dayLabel}</h3>
            <p id="station-stats-airtime-coverage" className={styles.note}>On-air status: {coverage(data.today.airtimeObservedSec, data.today.elapsedSec)}.</p>
            <p id="station-stats-listener-coverage" className={styles.note}>Listener counts: {coverage(data.today.listenerObservedSec, data.today.elapsedSec)}.</p>
            <p id="station-stats-tracking-since" className={styles.note}>Collection started: {data.trackingSince ? timeLabel(data.trackingSince, zone, true) : "Not recorded yet"}. Earlier listening cannot be recovered.</p>
            <p id="station-stats-last-sample" className={styles.note}>Last sample: {timeLabel(data.lastSampleAt, zone, true)}. Sampling target: every {data.sampleIntervalSec} seconds.</p>
            <p id="station-stats-generated-at" className={styles.note}>Snapshot: {timeLabel(data.generatedAt, zone, true)}.</p>
          </div>
          {data.today.airtimeObservedSec === 0 && data.today.listenerObservedSec === 0 && (
            <p id="station-stats-empty" className={styles.warning}>No observed time intervals for {dayLabel}. {data.isToday ? "Refresh after the next sample." : "No recorded station history is available for this date."} Missing observations do not mean the station was off air.</p>
          )}
          <h3 id="station-stats-timeline-title" className={styles.timelineHeading}>{metricInfo.title}</h3>
          <label className={styles.timelineControl} htmlFor="select-station-stats-metric">
            Timeline metric
            <select id="select-station-stats-metric" className={styles.selectInput} value={metric} onChange={event => setMetric(event.target.value as TimelineMetric)} aria-describedby="station-stats-metric-help">
              {Object.entries(TIMELINE_METRICS).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}
            </select>
          </label>
          <p id="station-stats-metric-help" className={styles.note}>{metricInfo.description}</p>
          <ListenerTimeline key={`${data.dayStart}:${zone}`} data={data} zone={zone} metric={metric} />
          {activity && <>
            <section id="section-station-stats-activity" className={styles.activitySection} aria-labelledby="station-stats-activity-title">
              <h3 id="station-stats-activity-title">Signed-in time vs Listening time</h3>
              <p id="station-stats-person-time-help" className={styles.note}>Combined user time for {dayLabel}: person-time summed across users, so totals can exceed 24 hours. Each user counts once across tabs. These are measured sample estimates, not a full-day history.</p>
              <p className={styles.note}>Signed-in means authenticated active app presence, not a persistent login cookie. Listening means actual forwarded audio, not simply an open player.</p>
              {activityError && <p id="station-stats-activity-error" className={styles.warning} role="alert">Activity source error: {activityError}. Available recorded observations remain below; latest activity counts are unavailable. Station observations are separate.</p>}
              <dl id="station-stats-person-time" className={`${styles.metrics} ${styles.combinedMetrics}`}>
                <div id="station-stats-signed-in-time" className={styles.metric}>
                  <dt>Combined user time — signed in</dt>
                  <dd id="station-stats-signed-in-time-value" className={styles.value}>{duration(activity.signedInSeconds)}</dd>
                </div>
                <div id="station-stats-listening-time" className={styles.metric}>
                  <dt>Combined user time — listening</dt>
                  <dd id="station-stats-listening-time-value" className={styles.value}>{duration(activity.listeningSeconds)}</dd>
                </div>
              </dl>
              <p id="station-stats-activity-current" className={styles.note}>{sampleLabel}: signed-in users {sampledCount(activity.current.signedIn, activityUnavailable, data.isToday)}; app listeners {sampledCount(activity.current.listening, activityUnavailable, data.isToday)}. {stale ? "Stale sample. " : ""}Sample: {timeLabel(data.current.at, zone, true)}.</p>
              <p id="station-stats-activity-coverage" className={styles.note}>Activity coverage: {coverage(activity.observedSec, data.today.elapsedSec)}. Recording since: {activity.trackingSince ? timeLabel(activity.trackingSince, zone, true) : "Unknown — not recorded yet"}. Earlier activity cannot be recovered.</p>
              <table id="station-stats-user-table" className={styles.userTable} aria-describedby="station-stats-person-time-help station-stats-activity-coverage">
                <caption>Per-user time — {data.date || "selected station day"}</caption>
                <thead><tr><th scope="col">User</th><th scope="col">Signed-in time</th><th scope="col">Listening time</th></tr></thead>
                <tbody>
                  {activity.users.map(user => <tr key={user.userId}>
                    <th scope="row">{userNames.get(user.userId) || "Former account"}</th>
                    <td>{duration(user.signedInSec)}</td>
                    <td>{duration(user.listeningSec)}</td>
                  </tr>)}
                  {activity.users.length === 0 && <tr><td colSpan={3}>{activity.observedSec > 0 ? "No user activity recorded in the observed intervals." : "Unknown — no user activity history recorded for this station day."}</td></tr>}
                </tbody>
              </table>
            </section>
            <section id="section-station-stats-devices" className={styles.activitySection} aria-labelledby="station-stats-devices-title">
              <h3 id="station-stats-devices-title">Devices</h3>
              <p className={styles.note}>Online means a heartbeat within 90 seconds, not an active TCP connection or streaming audio. Devices are counted separately from listeners and users.</p>
              <dl className={styles.metrics}>
                <div id="station-stats-devices-current" className={styles.metric} data-state={activityError ? "error" : stale ? "stale" : "recorded"}>
                  <dt>{data.isToday ? "Online at sample" : "Last recorded online"}</dt>
                  <dd id="station-stats-devices-current-value" className={styles.value}>{sampledCount(activity.current.devicesOnline, activityUnavailable, data.isToday)}</dd>
                  <dd className={styles.note}>{sampleLabel}: {timeLabel(data.current.at, zone, true)}.{stale ? " Stale sample." : ""}</dd>
                </div>
                <div id="station-stats-devices-peak" className={styles.metric}>
                  <dt>Peak online</dt>
                  <dd id="station-stats-devices-peak-value" className={styles.value}>{count(activity.peakDevices)}</dd>
                  <dd className={styles.note}>Highest sampled online count {dayLabel}.</dd>
                </div>
                <div id="station-stats-devices-average" className={styles.metric}>
                  <dt>Time-weighted mean online</dt>
                  <dd id="station-stats-devices-average-value" className={styles.value}>{count(activity.averageDevices, 1)}</dd>
                  <dd className={styles.note}>Average across observed activity time only.</dd>
                </div>
                <div id="station-stats-devices-unique" className={styles.metric}>
                  <dt>Distinct seen in day</dt>
                  <dd id="station-stats-devices-unique-value" className={styles.value}>{count(activity.uniqueDevices)}</dd>
                  <dd className={styles.note}>Each observed device counted once {dayLabel}.</dd>
                </div>
              </dl>
            </section>
          </>}
        </div>
      )}
    </section>
  );
}
