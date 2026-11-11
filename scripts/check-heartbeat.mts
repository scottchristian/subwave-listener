// Heartbeat gating: a tab earns its 15s presence write by playing audio,
// being visible, or recent interaction — never by merely existing.
//
// window/document are faked by hand (node has neither); the module under test
// only touches addEventListener, Date.now and document.hidden.
// Run: node scripts/check-heartbeat.mts (wired as `npm run check:heartbeat`).
import { shouldHeartbeat } from "../lib/heartbeat.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const listeners: Record<string, (() => void)[]> = {};
(globalThis as any).window = {
  addEventListener: (type: string, fn: () => void) => {
    (listeners[type] = listeners[type] || []).push(fn);
  },
};
const doc = { hidden: false };
(globalThis as any).document = doc;
const fire = (type: string) => (listeners[type] || []).forEach((fn) => fn());

// Playing always counts, even hidden: a pocket is using.
doc.hidden = true;
ok(shouldHeartbeat(true) === true, "playing + hidden -> heartbeat");

// Buried and silent: nothing.
ok(shouldHeartbeat(false) === false, "hidden + idle -> no heartbeat");

// Visible and just interacted: yes.
doc.hidden = false;
fire("pointerdown");
ok(shouldHeartbeat(false) === true, "visible + fresh interaction -> heartbeat");

// Visible but untouched for a day: no.
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
fire("pointerdown");
now += 16 * 60 * 1000;
ok(shouldHeartbeat(false) === false, "visible + 16min idle -> no heartbeat");
Date.now = realNow;

// Keys count as interaction too.
fire("keydown");
ok(shouldHeartbeat(false) === true, "keydown re-arms the heartbeat");

console.log(`  ${passed}/${passed + failed} heartbeat assertions passed`);
if (failed > 0) process.exit(1);
