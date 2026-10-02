// How long to keep asking, and what to say while asking.
//
// The booth is an AI DJ and the answer comes back when it has one. Some requests
// are answered in seconds; some sit until it has finished talking. The old copy
// said one fixed sentence for the whole of that, so a listener could not tell
// whether it was working, being ignored, or broken — and the silence grew without
// any sense of how long it had been going on.
//
// So the message escalates with elapsed time, and then gives up on its own. The
// thresholds are deliberately uneven: soon enough to reassure, then long enough
// that being told again means something new happened.
export const REQUEST_BUSY_AFTER_SEC = 12;
export const REQUEST_STruggLING_AFTER_SEC = 30;
export const REQUEST_TIMEOUT_SEC = 45;

/** What to tell the listener, given how long the booth has been silent. */
export function requestWaitMessage(secs: number): string {
  if (secs < REQUEST_BUSY_AFTER_SEC) {
    return "Sent to the booth — checking with the DJ…";
  }
  if (secs < REQUEST_STruggLING_AFTER_SEC) {
    return "Still nothing from the DJ. They’re probably mid-sentence right now — we’ll come back to you as soon as we can.";
  }
  return "I’m struggling to get a response from the DJ. Your request is in, but I might not get back to you on this one.";
}

/** The last word, once we stop waiting. The request is still queued either way. */
export const REQUEST_TIMEOUT_MESSAGE =
  "I’ve stopped waiting for the DJ, but your request did go through — it’s in the queue and may well play later.";
