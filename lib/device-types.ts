/**
 * The shape of everything a screen receives.
 *
 * WHY THIS IS A SEPARATE FILE. The payload is the contract between two things
 * that are written in different languages and fail in different ways: a Next.js
 * server that cannot tell a wall display is about to stop working, and firmware
 * that cannot tell a server stopped understanding it. Naming the shape once, in
 * one language both can be checked against, is cheaper than discovering the
 * disagreement on a wall in a common room.
 *
 * Field sources were verified against the live station on 2026-10-14, not
 * inferred from source. Three things that were wrong in the first draft:
 *
 *   - `context.showHandover` does not exist. The player reads it and gets
 *     nothing. There is no handover timestamp in now-playing at all, so
 *     `endsInSec` has to be computed from the SCHEDULE feed.
 *   - `upcoming` lives on the state feed, not now-playing, and it is usually
 *     empty. There is nothing to prefetch, so artwork is decoded after the
 *     track changes, every time.
 *   - Avatar paths need an `/api` prefix. The field says `/persona-avatar/<id>`
 *     and that path 404s; the working one is `/api/persona-avatar/<id>`.
 *
 * WHAT IS DELIBERATELY ABSENT. No spotifyUrl, no appleMusicUrl, no link of any
 * kind, no account-shaped field, nothing that refers to a person. A wall display
 * in a common room has no business sending anyone to another app, and has
 * nothing to say about whoever last touched it.
 * check-device-capabilities.mts fails the build if any of that appears.
 */

export type ThemeMode = "auto" | "day" | "night";
export type Orientation = "landscape" | "portrait";
export type IdleMode = "stay" | "dim" | "off";
export type DeviceView = "now" | "shows" | "settings";
export type DeviceStatus = "building" | "claimed" | "active" | "offline" | "revoked";

/** What the Skip button says. One of exactly four, chosen by the server. */
export type SkipLabel =
  | "Skip track"
  | "Skipping…"
  | `Skip in ${number}s`
  | "Next song incoming";

export interface DeviceSettings {
  /** 0-100. Capped to 70 in day mode by the server, never by the device. */
  brightness: number;
  orientation: Orientation;
  themeMode: ThemeMode;
  idleMode: IdleMode;
  idleMin: number;
  idlePct: number;
  skipEnabled: boolean;
}

export interface DeviceState {
  /** The device sets its clock from this and counts everything else off it. */
  serverNowMs: number;
  pollAfterSec: number;

  station: { name: string; logo: string };

  now: {
    subsonicId: string;
    title: string;
    artist: string;
    album?: string;
    art: string;
    /** Converted from the state feed's ISO 8601. The device never parses ISO. */
    startedAtMs: number;
    durationSec: number | null;
    live: boolean;
  };

  byline: {
    /** activeShow.persona.name || dj.name */
    presenter: string | null;
    show: string | null;
    /** From the state feed's session.startedAt. */
    onAirForSec: number | null;
    /** From computeShowRunway() over the schedule feed. NOT from now-playing. */
    endsInSec: number | null;
    live: boolean;
  };

  counts: {
    /** Read from the presence map. The device never writes to it, ever. */
    signedIn: number;
    listening: number;
  };

  /** The stream has nothing on it. This is what "off when idle" keys off. */
  streamIdle: boolean;

  theme: {
    /** Already resolved against the device's own themeMode. */
    mode: "day" | "night";
    isNight: boolean;
    sunriseMs: number;
    sunsetMs: number;
    /** Already capped for the mode — 70 in day, 100 at night. */
    brightness: number;
  };

  idle: { mode: IdleMode; min: number; pct: number };

  /** The entire Skip button, decided server-side. The device renders `label`. */
  skip: {
    shown: boolean;
    enabled: boolean;
    label: SkipLabel;
    cooldownSec: number;
    locked: boolean;
    /** Why it is unavailable, in words, e.g. "three people are listening". */
    reason: string | null;
  };

  settingsRev: number;
}

export interface DeviceSlot {
  /** Station-local, pre-formatted. The device never formats a time. */
  from: string;
  to: string;
  live: boolean;
  show: {
    id: string | null;
    name: string;
    host?: string;
    hostId?: string;
    guests?: { id: string; name: string }[];
    /** Only on expandable shows, and only fetched when a row is expanded. */
    avatar?: string;
  };
}

export interface DeviceSchedule {
  timezone: string;
  dayLabel: string;
  slots: DeviceSlot[];
}

export interface DeviceHeartbeatRequest {
  deviceId: string;
  firmwareVer: string;
  ip: string;
  rssi: number;
  orientation: Orientation;
  /** What the device believes it has applied, so a mismatch is visible. */
  appliedRev: number;
  /** Present only when the device changed something locally. */
  settings?: Partial<DeviceSettings>;
}

export interface DeviceHeartbeatResponse {
  settings: DeviceSettings;
  settingsRev: number;
  nextHeartbeatSec: number;
  /**
   * Present ONLY during a credential rotation's grace window. The device
   * authenticates with the token being replaced, so this is the one moment it
   * can be handed a new one — see lib/device-auth.ts.
   */
  rotatedToken?: string;
}

export interface DeviceClaimRequest {
  deviceId: string;
  claimToken: string;
  /** From the setup browser's Intl zone. The person is standing at the screen. */
  timezone?: string;
  lat?: number;
  lon?: number;
  saveAsStationDefault?: boolean;
}

export interface DeviceClaimResponse {
  token: string;
  settingsRev: number;
  pollAfterSec: number;
}