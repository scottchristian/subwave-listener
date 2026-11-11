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

// ---------------------------------------------------------------------------
// The lifecycle, as pure state.
//
// The maths above is easy to get right and easy to test. The wiring around it
// was where this feature actually broke: the cutoff is armed by a React effect
// watching `isPlaying`, the config arrives from an async fetch, and the two
// raced. Everything the player does here is therefore expressed as a pure
// transition, so the behaviour that matters — does the prompt appear, and does
// the stream really stop when it is ignored — is testable without a browser.
//
// `popup` lives in this state rather than in React so that "the prompt is
// showing" is part of what the tests assert, not an incidental detail of the
// component.
// ---------------------------------------------------------------------------

export type StillListeningPopup = null | "remind" | "stopped";

export type StillListeningState = {
  /** When the stream stops, or null when unarmed. */
  stopAtMs: number | null;
  /** Whether the reminder for this window has already fired. */
  reminded: boolean;
  /** The last stop was automatic, so the popup must survive the teardown. */
  autoStopped: boolean;
  popup: StillListeningPopup;
};

export const initialStillListeningState: StillListeningState = {
  stopAtMs: null,
  reminded: false,
  autoStopped: false,
  popup: null,
};

export type PlaybackChange = {
  isPlaying: boolean;
  wasPlaying: boolean;
  enabled: boolean;
  minutes: number;
  nowMs: number;
};

/**
 * The cutoff's reaction to playback and to config changes.
 *
 * Two bugs are fixed here, both of which let a listener play on forever with no
 * prompt ever appearing:
 *
 *  - Arming used to require the *rising edge* of `isPlaying`. The config comes
 *    from an async fetch, so tapping play before it lands armed nothing, and
 *    because the edge had already passed, nothing armed it afterwards either.
 *    Arming is now "playing and unarmed", which is the condition that actually
 *    matters and cannot race.
 *
 *  - Switching the feature off mid-session used to leave the armed stop in
 *    place. It is now disarmed, so the operator's change takes effect at once
 *    and re-enabling does not resurrect a stale deadline.
 */
export function onPlaybackChange(
  state: StillListeningState,
  change: PlaybackChange
): StillListeningState {
  const { isPlaying, wasPlaying, enabled, minutes, nowMs } = change;

  if (!isPlaying) {
    if (!wasPlaying) {
      // Still stopped: nothing to disarm, and the auto-stop flag has already
      // done its job.
      return { ...state, autoStopped: false };
    }
    if (state.autoStopped) {
      // The stop we just performed. Keep the popup up so the listener can see
      // why the audio went away, but drop the armed deadline.
      return { ...state, stopAtMs: null, reminded: false, autoStopped: false };
    }
    return { ...state, stopAtMs: null, reminded: false, popup: null };
  }

  if (!enabled) {
    // Playing, feature off. Disarm, and take any prompt down with it.
    return { stopAtMs: null, reminded: false, autoStopped: false, popup: null };
  }

  if (state.stopAtMs === null) {
    return {
      stopAtMs: stopAtFrom(nowMs, minutes),
      reminded: false,
      autoStopped: false,
      popup: null,
    };
  }

  // Already armed. A change to the window deliberately does NOT restart the
  // clock — the listener has already been playing for part of it.
  return state;
}

export type StillListeningTick = "none" | "remind" | "stop";

export type TickResult = { state: StillListeningState; action: StillListeningTick };

/**
 * One second of wall-clock watching. Returns what the player should do.
 *
 * Idle here is a deliberate no-op: the popup is not dismissed on a tick, so a
 * listener who walks away still sees the prompt when they come back, and the
 * stream stops either way.
 */
export function onStillListeningTick(
  state: StillListeningState,
  opts: { nowMs: number; reminderMs: number; enabled: boolean }
): TickResult {
  const { nowMs, reminderMs, enabled } = opts;
  if (!enabled || state.stopAtMs === null) return { state, action: "none" };
  const phase = stillListeningPhase(nowMs, state.stopAtMs, reminderMs);
  if (phase === "remind") {
    if (state.reminded) return { state, action: "none" };
    return {
      state: { ...state, reminded: true, popup: "remind" },
      action: "remind",
    };
  }
  if (phase === "stop") {
    return {
      state: { ...state, stopAtMs: null, reminded: false, autoStopped: true, popup: "stopped" },
      action: "stop",
    };
  }
  return { state, action: "none" };
}

/** The listener tapped "yes, still listening": push the stop out a whole window. */
export function onStillListeningConfirm(
  state: StillListeningState,
  minutes: number
): StillListeningState {
  if (state.stopAtMs === null) return state;
  return {
    ...state,
    stopAtMs: extendStop(state.stopAtMs, minutes),
    reminded: false,
    popup: null,
  };
}

/**
 * The listener tapped "stop now": the same teardown the timer would have done,
 * performed immediately.
 *
 * Unconditional on purpose. The button belongs to the prompt, but a listener who
 * presses it has asked for the stream to stop, and returning the state unchanged
 * when no deadline happened to be armed would leave a button that does nothing
 * at all — the worst possible response to an explicit instruction.
 */
export function onStillListeningStopNow(state: StillListeningState): StillListeningState {
  return { ...state, stopAtMs: null, reminded: false, autoStopped: true, popup: "stopped" };
}

/**
 * Whether a teardown should actually pause the stream.
 *
 * Keyed on the popup being "stopped", which is the machine saying a stop
 * happened. Testing `stopAtMs === null` instead would be true of an idle
 * machine that never did anything, and would pause the audio of a listener who
 * had not been touched.
 */
export function shouldStopStream(state: StillListeningState, intendedPlay: boolean): boolean {
  return intendedPlay && state.popup === "stopped";
}
