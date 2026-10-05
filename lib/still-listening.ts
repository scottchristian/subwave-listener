/**
 * "Are you still listening?" — stop idle streams instead of playing to an
 * empty room all day.
 *
 * CLIENT-SAFE BY CONSTRUCTION: pure functions, no imports. The player reads
 * the parsed config and both panels share the validation, so all three agree
 * on what "60 minutes with a 10-minute reminder" means.
 */

export const STILL_LISTENING_KEYS = {
  enabled: "stillListeningEnabled",
  minutes: "stillListeningMinutes",
  reminder: "stillListeningReminderMinutes",
} as const;

export type StillListeningConfig = {
  enabled: boolean;
  /** Full listening window in minutes: play (or confirm) to stop. */
  minutes: number;
  /** How many minutes before the stop the reminder appears. */
  reminderMinutes: number;
};

export const STILL_LISTENING_DEFAULTS: StillListeningConfig = {
  enabled: false,
  minutes: 60,
  reminderMinutes: 10,
};

export const STILL_LISTENING_LIMITS = {
  minutesMin: 5,
  minutesMax: 720,
  reminderMin: 1,
} as const;

/** Raw settings rows (or player JSON) into a config that cannot misbehave. */
export function parseStillListening(raw: {
  enabled?: unknown;
  minutes?: unknown;
  reminderMinutes?: unknown;
}): StillListeningConfig {
  const enabled = String(raw.enabled ?? "") === "true";
  let minutes = Math.floor(Number(raw.minutes));
  if (!Number.isFinite(minutes)) minutes = STILL_LISTENING_DEFAULTS.minutes;
  minutes = Math.min(
    STILL_LISTENING_LIMITS.minutesMax,
    Math.max(STILL_LISTENING_LIMITS.minutesMin, minutes)
  );
  let reminderMinutes = Math.floor(Number(raw.reminderMinutes));
  if (!Number.isFinite(reminderMinutes)) reminderMinutes = STILL_LISTENING_DEFAULTS.reminderMinutes;
  reminderMinutes = Math.min(
    minutes - 1,
    Math.max(STILL_LISTENING_LIMITS.reminderMin, reminderMinutes)
  );
  return { enabled, minutes, reminderMinutes };
}

/** Admin form validation: specific rejections, not silent clamps. */
export function validateStillListening(
  minutesRaw: string,
  reminderRaw: string
): { ok: true; minutes: number; reminderMinutes: number } | { ok: false; error: string } {
  const minutes = Math.floor(Number(minutesRaw));
  if (!Number.isInteger(minutes) || minutes < STILL_LISTENING_LIMITS.minutesMin || minutes > STILL_LISTENING_LIMITS.minutesMax) {
    return { ok: false, error: `Listening time must be ${STILL_LISTENING_LIMITS.minutesMin}–${STILL_LISTENING_LIMITS.minutesMax} minutes.` };
  }
  const reminderMinutes = Math.floor(Number(reminderRaw));
  if (!Number.isInteger(reminderMinutes) || reminderMinutes < STILL_LISTENING_LIMITS.reminderMin || reminderMinutes >= minutes) {
    return { ok: false, error: `Reminder must be ${STILL_LISTENING_LIMITS.reminderMin} minute(s) or more before the stop — less than ${minutes}.` };
  }
  return { ok: true, minutes, reminderMinutes };
}

/** Where the stop lands from a start (or confirm) moment. */
export function stopAtFrom(startMs: number, minutes: number): number {
  return startMs + minutes * 60 * 1000;
}

/**
 * Confirming pushes the STOP out by a whole window — it does not restart the
 * clock from the press. 9:00 start, 60-minute window, confirm at 9:50:
 * the stream now stops at 11:00, not 10:50.
 */
export function extendStop(stopAtMs: number, minutes: number): number {
  return stopAtMs + minutes * 60 * 1000;
}

export type StillListeningPhase = "listening" | "remind" | "stop";

/** Which phase `now` falls in against an armed stop time. */
export function stillListeningPhase(nowMs: number, stopAtMs: number, reminderMs: number): StillListeningPhase {
  if (nowMs >= stopAtMs) return "stop";
  if (nowMs >= stopAtMs - reminderMs) return "remind";
  return "listening";
}
