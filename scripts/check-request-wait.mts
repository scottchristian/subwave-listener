// Throwaway: the request message ladder. The thresholds decide what a listener is
// told and when, and a wrong number here either panics people or leaves them
// staring at a button for a minute.
import {
  requestWaitMessage,
  REQUEST_BUSY_AFTER_SEC,
  REQUEST_STruggLING_AFTER_SEC,
  REQUEST_TIMEOUT_SEC,
  REQUEST_TIMEOUT_MESSAGE,
} from "../lib/requestwait.ts";

type Case = [secs: number, mustContain: string, why: string];

const cases: Case[] = [
  [0, "checking with the DJ", "immediately: we are checking"],
  [REQUEST_BUSY_AFTER_SEC - 1, "checking with the DJ", "one second before the busy line"],
  [REQUEST_BUSY_AFTER_SEC, "nothing from the DJ", "exactly at the busy threshold"],
  [REQUEST_STruggLING_AFTER_SEC - 1, "nothing from the DJ", "one second before struggling"],
  [REQUEST_STruggLING_AFTER_SEC, "struggling", "exactly at the struggling threshold"],
  [REQUEST_TIMEOUT_SEC - 1, "struggling", "still struggling one second before giving up"],
];

let failed = 0;
for (const [secs, needle, why] of cases) {
  const msg = requestWaitMessage(secs);
  if (!msg.toLowerCase().includes(needle.toLowerCase())) {
    failed++;
    console.log(`  FAIL  ${secs}s -> ${JSON.stringify(msg.slice(0, 60))}, expected to mention "${needle}"  (${why})`);
  }
}

// The ladder has to be monotonic: later never claims more confidence than earlier.
const a = requestWaitMessage(0), b = requestWaitMessage(REQUEST_STruggLING_AFTER_SEC);
if (a === b) { failed++; console.log("  FAIL  the message never changes"); }

// And the timeout must be later than the last escalation, or the "still trying"
// line never gets said.
if (REQUEST_TIMEOUT_SEC <= REQUEST_STruggLING_AFTER_SEC) {
  failed++;
  console.log(`  FAIL  timeout (${REQUEST_TIMEOUT_SEC}) is not after struggling (${REQUEST_STruggLING_AFTER_SEC})`);
}
if (REQUEST_STruggLING_AFTER_SEC <= REQUEST_BUSY_AFTER_SEC) {
  failed++;
  console.log("  FAIL  struggling is not after busy");
}

// The timeout message has to make clear the request was NOT lost, or the listener
// will send it again.
if (!/still|in the queue|went through|may well play/i.test(REQUEST_TIMEOUT_MESSAGE)) {
  failed++;
  console.log(`  FAIL  the timeout message does not say the request survived: ${JSON.stringify(REQUEST_TIMEOUT_MESSAGE)}`);
}

console.log(`  ${cases.length + 4 - failed}/${cases.length + 4} passed`);
if (failed) process.exit(1);
