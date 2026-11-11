export type StationStatsResponse = {
  generatedAt: string;
  timeZone: string | null;
  /** Selected station-local calendar date (today by default). */
  date: string | null;
  todayDate: string | null;
  availableDates: string[];
  isToday: boolean;
  dayStart: string | null;
  /** Next local midnight; today's estimates stop at generatedAt. */
  dayEnd: string | null;
  trackingSince: string | null;
  lastSampleAt: string | null;
  sampleIntervalSec: number;
  current: {
    listeners: number | null;
    onAir: boolean | null;
    at: string | null;
    stale: boolean;
  };
  /** Metrics for the selected day; property name retained for compatibility. */
  today: {
    airtimeSec: number | null;
    listenerSeconds: number | null;
    averageListeners: number | null;
    peakListeners: number | null;
    airtimeObservedSec: number;
    listenerObservedSec: number;
    elapsedSec: number;
  };
  activity: {
    trackingSince: string | null;
    /** Fresh counts today; the last recorded sample on historical days. */
    current: { signedIn: number | null; listening: number | null; devicesOnline: number | null };
    signedInSeconds: number | null;
    listeningSeconds: number | null;
    observedSec: number;
    peakDevices: number | null;
    averageDevices: number | null;
    uniqueDevices: number | null;
    users: Array<{ userId: string; signedInSec: number; listeningSec: number }>;
    error: string | null;
  };
  /** Bounded held observations and unknown gaps, clipped to the selected day and server time. */
  timeline: Array<{
    at: string;
    endAt: string;
    listeners: number | null;
    onAir: boolean | null;
    signedIn: number | null;
    listening: number | null;
    devicesOnline: number | null;
  }>;
  error: string | null;
};
