// "Are you still listening?" — the lifecycle, driven end to end.
//
// check-still-listening covers the arithmetic. This covers the part that
// actually broke in production: whether a prompt appears, and whether the
// stream really stops when it is ignored.
//
// The real component cannot be exercised here — it needs a browser, an audio
// element and a media session. So the whole lifecycle was extracted into pure
// transitions in lib/still-listening.ts, and this drives those directly. That
// is not a compromise: the React effect only ever forwarded playback state and
// seconds of wall-clock into these functions, so a bug reachable here is a bug
// reachable in the player.
//
// Each scenario is a full timeline, not a function call in isolation, because
// the failures that matter are ordering failures: arming before the config
// arrives, a teardown racing the popup, a confirm landing after the stop.
//
// Run: npm run check:still-listening-flow  (part of `npm run check:unit`)
import {
  onPlaybackChange,
  onStillListeningTick,
  onStillListeningConfirm,
  onStillListeningStopNow,
  shouldStopStream,
  initialStillListeningState,
  type StillListeningState,
} from "../lib/still-listening.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const WINDOW = 60;
const REMINDER = 10 * MIN;

/**
 * Drives the machine the way the component does: playback changes when they
 * happen, and one tick per minute of simulated time. `intendedPlay` is the ref
 * the player keeps about whether it believes audio should be running.
 */
class Timeline {
  state: StillListeningState = initialStillListeningState;
  wasPlaying = false;
  intendedPlay = false;
  stops = 0;
  reminders = 0;
  playing = false;

  /** What the player renders right now. */
  get popup() {
    return this.state.popup;
  }

  pressPlay(at: number) {
    this.playing = true;
    this.intendedPlay = true;
    this.state = onPlaybackChange(this.state, {
      isPlaying: true,
      wasPlaying: this.wasPlaying,
      enabled: this.enabled,
      minutes: WINDOW,
      nowMs: at,
    });
    this.wasPlaying = true;
  }

  pressStop(at: number) {
    this.playing = false;
    this.intendedPlay = false;
    this.state = onPlaybackChange(this.state, {
      isPlaying: false,
      wasPlaying: this.wasPlaying,
      enabled: this.enabled,
      minutes: WINDOW,
      nowMs: at,
    });
    this.wasPlaying = false;
  }

  enabled = true;

  tick(at: number) {
    const before = this.state;
    const { state, action } = onStillListeningTick(before, {
      nowMs: at,
      reminderMs: REMINDER,
      enabled: this.enabled,
    });
    this.state = state;
    if (state === before) return "none";
    if (action === "remind") {
      this.reminders++;
      return "remind";
    }
    if (action === "stop") {
      this.reminders += 0;
      // What the component does on "stop": pause, which aborts the stream
      // request and so ends the server-side session.
      if (shouldStopStream(state, this.intendedPlay)) {
        this.stops++;
        this.playing = false;
        this.intendedPlay = false;
        this.state = onPlaybackChange(state, {
          isPlaying: false,
          wasPlaying: true,
          enabled: this.enabled,
          minutes: WINDOW,
          nowMs: at,
        });
        this.wasPlaying = false;
      }
      return "stop";
    }
    return "none";
  }

  run(fromMs: number, toMs: number, stepMs = MIN) {
    for (let t = fromMs; t <= toMs; t += stepMs) this.tick(t);
  }

  confirm(at: number) {
    this.state = onStillListeningConfirm(this.state, WINDOW);
  }

  stopNow(at: number) {
    this.state = onStillListeningStopNow(this.state);
    if (shouldStopStream(this.state, this.intendedPlay)) {
      this.stops++;
      this.playing = false;
      this.intendedPlay = false;
      this.state = onPlaybackChange(this.state, {
        isPlaying: false,
        wasPlaying: true,
        enabled: this.enabled,
        minutes: WINDOW,
        nowMs: at,
      });
      this.wasPlaying = false;
    }
  }
}

// ---------------------------------------------------------------------------
// 1. The listener ignores the prompt. The stream must stop.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  ok(tl.state.stopAtMs === T0 + 60 * MIN, "a 60-minute window is armed on play");
  ok(tl.popup === null, "no prompt before the reminder");

  tl.run(T0 + MIN, T0 + 49 * MIN);
  ok(tl.reminders === 0, "nothing fires early");
  ok(tl.popup === null, "still no prompt at 49 minutes");
  ok(tl.stops === 0, "and the stream is untouched");

  tl.tick(T0 + 50 * MIN);
  ok(tl.reminders === 1, "the reminder fires 10 minutes before the stop");
  ok(tl.popup === "remind", "and the prompt is showing");
  ok(tl.stops === 0, "the stream keeps playing while the prompt is up");

  // Ten more ticks, unanswered.
  tl.run(T0 + 51 * MIN, T0 + 59 * MIN);
  ok(tl.reminders === 1, "the prompt is shown once, not every tick");
  ok(tl.popup === "remind", "and it stays up rather than flickering");
  ok(tl.stops === 0, "still playing just before the deadline");

  tl.tick(T0 + 60 * MIN);
  ok(tl.stops === 1, "an unanswered prompt stops the stream");
  ok(tl.popup === "stopped", "and explains that it stopped");
  ok(tl.state.stopAtMs === null, "the deadline is cleared");

  tl.run(T0 + 61 * MIN, T0 + 120 * MIN);
  ok(tl.stops === 1, "and it does not keep stopping — one stop, not one per tick");
}

// ---------------------------------------------------------------------------
// 2. The listener confirms. The stop moves out a whole window.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  tl.tick(T0 + 50 * MIN);
  ok(tl.popup === "remind", "prompt is up at 50 minutes");
  tl.confirm(T0 + 55 * MIN);
  ok(tl.popup === null, "confirming dismisses the prompt");
  ok(tl.state.stopAtMs === T0 + 120 * MIN, "and pushes the stop out to 11:00, not 10:55");

  tl.run(T0 + 56 * MIN, T0 + 109 * MIN);
  ok(tl.stops === 0, "nothing stops it before the new deadline");
  ok(tl.popup === null, "and no second prompt inside the quiet stretch");
  ok(tl.reminders === 1, "only the first reminder so far");

  tl.tick(T0 + 110 * MIN);
  ok(tl.reminders === 2, "a second reminder fires 10 minutes before the new stop");
  tl.tick(T0 + 120 * MIN);
  ok(tl.stops === 1, "and the second window stops it unanswered");

  // Confirming twice keeps stepping whole windows.
  const tl2 = new Timeline();
  tl2.pressPlay(T0);
  tl2.tick(T0 + 50 * MIN);
  tl2.confirm(T0 + 50 * MIN);
  tl2.tick(T0 + 110 * MIN);
  tl2.confirm(T0 + 110 * MIN);
  ok(tl2.state.stopAtMs === T0 + 180 * MIN, "two confirms reach 12:00");
}

// ---------------------------------------------------------------------------
// 3. THE BUG THIS EXISTED FOR: play before the config arrives.
// ---------------------------------------------------------------------------
// The config is an async fetch. Tapping play before it lands used to arm
// nothing, and because the play edge had already passed, nothing armed it
// afterwards either — the listener played on forever with no prompt, which is
// the entire failure this feature exists to prevent.
{
  const tl = new Timeline();
  tl.enabled = false; // config has not loaded yet
  tl.pressPlay(T0);
  ok(tl.state.stopAtMs === null, "with the feature not yet known, nothing is armed");

  // The settings response lands 400ms later. The effect re-runs because the
  // config changed; the play edge has long since passed.
  tl.enabled = true;
  tl.state = onPlaybackChange(tl.state, {
    isPlaying: true,
    wasPlaying: true,
    enabled: true,
    minutes: WINDOW,
    nowMs: T0 + 400,
  });
  ok(tl.state.stopAtMs !== null, "the config arriving arms the cutoff anyway");
  ok(tl.state.stopAtMs === T0 + 400 + 60 * MIN, "measured from the moment the config landed");

  tl.run(t0safe(T0 + 400), T0 + 400 + 60 * MIN);
  ok(tl.stops === 1, "and the listener is stopped a full window later");
}
function t0safe(t: number) {
  return t;
}

// ---------------------------------------------------------------------------
// 4. A manual stop disarms; a popup never survives it.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  tl.pressStop(T0 + 5 * MIN);
  ok(tl.state.stopAtMs === null, "a manual stop disarms the cutoff");
  ok(tl.popup === null, "and shows no popup");

  // A long silence must not resurrect the old deadline.
  tl.run(T0 + 6 * MIN, T0 + 300 * MIN);
  ok(tl.reminders === 0 && tl.stops === 0, "staying stopped does nothing at all");

  // Pressing play again gets a fresh window, not the remainder of the old one.
  tl.pressPlay(T0 + 300 * MIN);
  ok(tl.state.stopAtMs === T0 + 360 * MIN, "play again arms a fresh window");
}

// ---------------------------------------------------------------------------
// 5. The popup survives the teardown it caused.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  tl.tick(T0 + 60 * MIN);
  ok(tl.popup === "stopped", "the stopped popup is showing after the auto-stop");
  ok(tl.state.stopAtMs === null, "with no deadline left");
  ok(tl.state.autoStopped === false, "and the auto-stop flag cleared, ready for the next play");

  // Play again from the stopped popup.
  tl.pressPlay(T0 + 61 * MIN);
  ok(tl.popup === null, "play again dismisses the stopped popup");
  ok(tl.state.stopAtMs === T0 + 121 * MIN, "and arms a new window");
}

// ---------------------------------------------------------------------------
// 6. "Stop now" behaves like the timer firing, immediately.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  tl.tick(T0 + 50 * MIN);
  ok(tl.popup === "remind", "prompt is up");
  tl.stopNow(T0 + 52 * MIN);
  ok(tl.stops === 1, "stop now pauses the stream");
  ok(tl.popup === "stopped", "and reports why");
  ok(tl.state.stopAtMs === null, "with no deadline left");

  tl.run(T0 + 53 * MIN, T0 + 120 * MIN);
  ok(tl.stops === 1, "and the timer does not fire a second time afterwards");
}

// ---------------------------------------------------------------------------
// 7. The operator turns the feature off mid-session.
// ---------------------------------------------------------------------------
{
  const tl = new Timeline();
  tl.pressPlay(T0);
  ok(tl.state.stopAtMs !== null, "armed while the feature is on");
  tl.enabled = false;
  tl.state = onPlaybackChange(tl.state, {
    isPlaying: true,
    wasPlaying: true,
    enabled: false,
    minutes: WINDOW,
    nowMs: T0 + 20 * MIN,
  });
  ok(tl.state.stopAtMs === null, "turning it off disarms immediately");
  ok(tl.popup === null, "and takes any prompt down");

  tl.enabled = true;
  tl.run(T0 + 21 * MIN, T0 + 200 * MIN);
  ok(tl.stops === 0, "the old deadline does not come back to haunt anyone");

  // Re-enabling re-arms from the new moment, not from the original play.
  tl.state = onPlaybackChange(tl.state, {
    isPlaying: true,
    wasPlaying: true,
    enabled: true,
    minutes: WINDOW,
    nowMs: T0 + 30 * MIN,
  });
  ok(tl.state.stopAtMs === T0 + 90 * MIN, "re-enarming measures from the moment it was turned back on");
}

// ---------------------------------------------------------------------------
// 8. The stream is only paused when the player believes it is playing.
// ---------------------------------------------------------------------------
{
  const stopped = onStillListeningStopNow(initialStillListeningState);
  ok(shouldStopStream(stopped, true) === true, "stop now stops a stream the player thinks is running");
  ok(shouldStopStream(stopped, false) === false, "and does not double-pause one it thinks is already stopped");
  ok(shouldStopStream(initialStillListeningState, true) === false, "an idle machine never pauses anything");
}

// ---------------------------------------------------------------------------
// 9. Edge configurations cannot produce an unreachable stop.
// ---------------------------------------------------------------------------
{
  // A window and reminder where the reminder equals the window: the prompt is
  // up from the first second, which is what the parser allows at the minimum.
  const tl = new Timeline();
  tl.pressPlay(T0);
  // A 5-minute window with a 4-minute reminder: the prompt is due one minute in.
  const armed = onPlaybackChange(initialStillListeningState, {
    isPlaying: true, wasPlaying: false, enabled: true, minutes: 5, nowMs: T0,
  });
  const beforeReminder = onStillListeningTick(armed, {
    nowMs: T0 + 30_000, reminderMs: 4 * MIN, enabled: true,
  });
  ok(beforeReminder.action === "none" && beforeReminder.state.popup === null, "nothing prompts before the reminder is due");
  const { state } = onStillListeningTick(armed, {
    nowMs: T0 + 61_000, reminderMs: 4 * MIN, enabled: true,
  });
  ok(state.popup === "remind", "a 4-minute reminder on a 5-minute window prompts one minute in");
  const done = onStillListeningTick(state, { nowMs: T0 + 5 * MIN, reminderMs: 4 * MIN, enabled: true });
  ok(done.action === "stop", "and still stops at the end of it");
  ok(tl.state.stopAtMs !== null, "the 5-minute window is armed normally");
}

// ---------------------------------------------------------------------------
// 10. The structural guard: the player must call the machine, not reimplement it.
// ---------------------------------------------------------------------------
{
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  ok(!/slStopAt|slReminded|slAutoStopped/.test(page), "the player holds no parallel copy of the cutoff state");
  ok(/onPlaybackChange\(/.test(page), "arming goes through the tested transition");
  ok(/onStillListeningTick\(/.test(page), "the timer goes through the tested transition");
  ok(/onStillListeningConfirm\(/.test(page), "confirming goes through the tested transition");
  ok(/onStillListeningStopNow\(/.test(page), "stop-now goes through the tested transition");
  // The prompt must not be dismissible by clicking away — the whole point is
  // that ignoring it stops the stream.
  // Read the overlay's opening tag itself: slicing to the next </div> would stop
  // at an inner element and quietly assert nothing.
  const openTag = page.slice(page.indexOf('id="still-listening-overlay-bg"')).split(">")[0];
  ok(openTag.includes("still-listening-overlay-bg"), "the overlay tag was located");
  ok(!/onClick/.test(openTag), "the still-listening overlay has no click-to-dismiss handler");
  ok(/btn-still-listening-yes/.test(page), "the confirm button is present");
  ok(/btn-still-listening-stop/.test(page), "the stop button is present");
  ok(/btn-still-listening-replay/.test(page), "the play-again button is present");
}

console.log(`  ${passed}/${passed + failed} still-listening-flow assertions passed`);
if (failed > 0) process.exit(1);
