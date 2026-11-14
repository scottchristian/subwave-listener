// Admin ntfy alerts: the pure alert gate, the sender driven against a fake
// fetch, and the api-gate shape of the two new admin routes.
//
// The secrets rule under test: the topic and token are configuration secrets,
// so a failed send must never log either. The failure path is asserted by
// capturing console.error and grepping it for the exact values.
//
// Run: node --import ./scripts/test-register.mjs scripts/check-ntfy.mts
// (wired as `npm run check:ntfy`)
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  alertGate,
  endAlert,
  gateAlert,
  lastStatus,
  notifyAdmins,
  readConfig,
  resetAlertGateForTests,
} from "../lib/ntfy.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`);
  }
}

// The suite owns NTFY_* for its run and puts the real values back after.
const SAVED = {
  NTFY_ENABLED: process.env.NTFY_ENABLED,
  NTFY_TOPIC: process.env.NTFY_TOPIC,
  NTFY_BASE_URL: process.env.NTFY_BASE_URL,
  NTFY_TOKEN: process.env.NTFY_TOKEN,
};
function clearNtfyEnv() {
  delete process.env.NTFY_ENABLED;
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_BASE_URL;
  delete process.env.NTFY_TOKEN;
}
function restoreNtfyEnv() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
}

const logged = { errors: [] as string[], logs: [] as string[] };
const origError = console.error;
const origLog = console.log;
console.error = (...a: unknown[]) => { logged.errors.push(a.map(String).join(" ")); };
console.log = (...a: unknown[]) => { logged.logs.push(a.map(String).join(" ")); };

// ---------------------------------------------------------------- readConfig

clearNtfyEnv();
{
  const c = readConfig();
  ok(c.enabled === false, "nothing configured means off");
  ok(c.baseUrl === "https://ntfy.sh", "the base URL defaults to ntfy.sh", c.baseUrl);
  ok(c.topic === "" && c.token === "", "topic and token start empty");
}
{
  process.env.NTFY_ENABLED = "1";
  ok(readConfig().enabled === false, "the flag alone does not enable alerts");
  delete process.env.NTFY_ENABLED;
  process.env.NTFY_TOPIC = "my-topic";
  ok(readConfig().enabled === false, "a topic alone does not enable alerts");
  for (const truthy of ["1", "true", "TRUE", "yes", "on", "ON"]) {
    process.env.NTFY_ENABLED = truthy;
    ok(readConfig().enabled === true, `flag "${truthy}" + topic enables alerts`);
  }
  for (const falsy of ["0", "false", "no", "off", "2", "enabled", ""]) {
    process.env.NTFY_ENABLED = falsy;
    ok(readConfig().enabled === false, `flag "${falsy}" stays off`);
  }
  process.env.NTFY_TOPIC = "  padded-topic  ";
  process.env.NTFY_ENABLED = "1";
  const c = readConfig();
  ok(c.enabled === true && c.topic === "padded-topic", "the topic is trimmed");
  process.env.NTFY_BASE_URL = "https://ntfy.example.com/";
  ok(readConfig().baseUrl === "https://ntfy.example.com", "a trailing slash is stripped");
  process.env.NTFY_BASE_URL = "https://ntfy.sh/";
  ok(readConfig().baseUrl === "https://ntfy.sh", "the default with a slash normalizes to the default");
  process.env.NTFY_TOKEN = "tk-secret";
  ok(readConfig().token === "tk-secret", "the token passes through");
  clearNtfyEnv();
}

// ------------------------------------------------------------------ the gate

{
  // The pure gate on a fresh map: first occurrence sends.
  let st = new Map<string, number>();
  let r = gateAlert(st, "db-permanent", 1000);
  ok(r.send === true && r.state.get("db-permanent") === 1000, "first occurrence sends");
  ok(r.state === st, "the gate state is the same map, mutated in place");
  // Repeat inside the cooldown is suppressed.
  r = gateAlert(st, "db-permanent", 1000 + 899_999);
  ok(r.send === false, "a repeat inside the cooldown is suppressed");
  // One millisecond past the cooldown sends again.
  r = gateAlert(st, "db-permanent", 1000 + 900_000);
  ok(r.send === true, "the cooldown elapsed — it sends again");
  // A custom cooldown is honored.
  st = new Map();
  ok(gateAlert(st, "k", 0, 60_000).send === true, "custom cooldown: first sends");
  ok(gateAlert(st, "k", 30_000, 60_000).send === false, "custom cooldown: 30s < 60s suppresses");
  ok(gateAlert(st, "k", 60_000, 60_000).send === true, "custom cooldown: 60s reaches it");
  // Independent keys do not interfere.
  st = new Map();
  gateAlert(st, "a", 0);
  ok(gateAlert(st, "b", 0).send === true, "gating one key does not suppress another");
  // Recovery always sends, clears the key, and re-arms it.
  st = new Map();
  gateAlert(st, "db-unreachable", 0);
  const rec = endAlert(st, "db-unreachable");
  ok(rec.send === true, "recovery always sends");
  ok(!st.has("db-unreachable"), "recovery removes the key");
  ok(gateAlert(st, "db-unreachable", 1).send === true, "the next failure is a first occurrence again");
  // endAlert on an unknown key still sends (a recovery without an open alert
  // means the state was lost; the owner should still hear the all-clear).
  ok(endAlert(new Map(), "never-opened").send === true, "recovery without an open alert still sends");
  // The live gate sits on globalThis and the seam resets it.
  resetAlertGateForTests();
  alertGate().set("x", 123);
  ok(alertGate().size === 1, "the live gate is populated");
  resetAlertGateForTests();
  ok(alertGate().size === 0, "the reset seam clears the live gate");
  ok(lastStatus().lastSentAt === null && lastStatus().lastError === null, "and clears the reported status");
}

// ---------------------------------------------------------- notifyAdmins

type Call = { url: string; init: RequestInit };
function fakeFetch(calls: Call[], respond?: () => Response): typeof fetch {
  return (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond ? respond() : new Response("ok", { status: 200 });
  }) as typeof fetch;
}
const headersOf = (c: Call) => (c.init.headers || {}) as Record<string, string>;

{
  // Unconfigured: a no-op that returns false and touches no network.
  clearNtfyEnv();
  const calls: Call[] = [];
  const r = await notifyAdmins("Title", "body", undefined, fakeFetch(calls));
  ok(r === false, "unconfigured notifyAdmins returns false");
  ok(calls.length === 0, "unconfigured notifyAdmins never fetches");
}
{
  process.env.NTFY_ENABLED = "1";
  process.env.NTFY_TOPIC = "topic-secret-abc";
  const calls: Call[] = [];
  const r = await notifyAdmins("Wake failed", "the body", { priority: 4, tags: ["warning", "rotating_light"] }, fakeFetch(calls));
  ok(r === true, "a 2xx answers true");
  ok(calls.length === 1, "exactly one request went out");
  ok(calls[0].url === "https://ntfy.sh/topic-secret-abc", "the URL is base/topic", calls[0].url);
  ok(calls[0].init.method === "POST", "it is a POST");
  ok(calls[0].init.body === "the body", "the body rides along");
  const h = headersOf(calls[0]);
  ok(h["Title"] === "Wake failed", "the Title header is the alert title");
  ok(h["Priority"] === "4", "the Priority header follows opts");
  ok(h["Tags"] === "warning,rotating_light", "tags are comma-joined");
  ok(!("Authorization" in h), "no token means no Authorization header");
  ok(calls[0].init.signal instanceof AbortSignal, "a timeout signal is attached");
  ok(lastStatus().lastSentAt !== null, "success stamps lastSentAt");
  ok(lastStatus().lastError === null, "success clears lastError");
  ok(logged.logs.some((l) => l.includes("[ntfy] sent: Wake failed")), "the success log names the alert");
}
{
  // Defaults: priority 3, no tags header when none are given.
  const calls: Call[] = [];
  await notifyAdmins("Defaults", "b", undefined, fakeFetch(calls));
  const h = headersOf(calls[0]);
  ok(h["Priority"] === "3", "priority defaults to 3");
  ok(!("Tags" in h), "no tags means no Tags header");
}
{
  // Token: Bearer only when one is set.
  process.env.NTFY_TOKEN = "token-secret-xyz";
  let calls: Call[] = [];
  await notifyAdmins("Authed", "b", undefined, fakeFetch(calls));
  ok(headersOf(calls[0])["Authorization"] === "Bearer token-secret-xyz", "a token becomes Bearer auth");
  delete process.env.NTFY_TOKEN;
  calls = [];
  await notifyAdmins("NoAuthed", "b", undefined, fakeFetch(calls));
  ok(!("Authorization" in headersOf(calls[0])), "and unsetting it removes the header again");
}
{
  // Custom base URL with trailing slash normalizes into the URL.
  process.env.NTFY_BASE_URL = "https://ntfy.example.com/";
  const calls: Call[] = [];
  await notifyAdmins("Base", "b", undefined, fakeFetch(calls));
  ok(calls[0].url === "https://ntfy.example.com/topic-secret-abc", "the base URL is normalized", calls[0].url);
  delete process.env.NTFY_BASE_URL;
}
{
  // Body cap: a huge body is cut to ~3500 chars.
  const calls: Call[] = [];
  await notifyAdmins("Cap", "x".repeat(5000), undefined, fakeFetch(calls));
  ok(String(calls[0].init.body).length === 3500, "the body is capped at 3500 chars", String(calls[0].init.body).length);
}
{
  // A 500 answers false, sets lastError, logs the failure — without the
  // topic or the token anywhere in the log.
  logged.errors.length = 0;
  const calls: Call[] = [];
  const r = await notifyAdmins("Boom", "b", undefined, fakeFetch(calls, () => new Response("err", { status: 500 })));
  ok(r === false, "a 500 answers false");
  ok(lastStatus().lastError === "HTTP 500", "the status is recorded for the admin route");
  ok(logged.errors.some((l) => l.includes("[ntfy] send failed: HTTP 500")), "the failure is logged with the status");
  const leak = logged.errors.join("\n");
  ok(!leak.includes("topic-secret-abc"), "the failure log never contains the topic");
  ok(!leak.includes("token-secret-xyz"), "or the token");
}
{
  // A rejecting fetch answers false and does not throw — and still leaks
  // neither secret. The rejection message can carry a URL, so the topic must
  // stay out of what gets logged; the sender only logs the error text.
  process.env.NTFY_TOKEN = "token-secret-xyz";
  logged.errors.length = 0;
  const calls: Call[] = [];
  let threw = false;
  let r = false;
  try {
    r = await notifyAdmins("NetDown", "b", undefined, fakeFetch(calls, () => { throw new Error("socket hang up"); }));
  } catch {
    threw = true;
  }
  ok(!threw, "a rejecting fetch does not throw");
  ok(r === false, "a rejecting fetch answers false");
  ok(logged.errors.some((l) => l.includes("[ntfy] send failed:")), "the failure is logged");
  const leak = logged.errors.join("\n");
  ok(!leak.includes("topic-secret-abc"), "the rejection log never contains the topic");
  ok(!leak.includes("token-secret-xyz"), "or the token");
}

clearNtfyEnv();
resetAlertGateForTests();

// --------------------------------------------- the admin routes pass the gate
//
// check:api-gates walks every route handler and demands a session check;
// these two are new, so assert the shape here and let the full gate run in
// the chain.
const REPO = path.resolve(import.meta.dirname, "..");
for (const rel of ["app/api/admin/alerts/route.ts", "app/api/admin/alerts/test/route.ts"]) {
  const src = readFileSync(path.join(REPO, rel), "utf8");
  ok(/await\s+requireAdmin\s*\(/.test(src), `${rel} authenticates through the shared admin gate`);
  ok(/status:\s*403/.test(src), `${rel} refuses a non-admin with 403`);
}
{
  // The GET shape must never carry the secrets: the publicStatus object is
  // spelled out in the route, and its keys are exactly the safe ones.
  const src = readFileSync(path.join(REPO, "app/api/admin/alerts/route.ts"), "utf8");
  const body = src.slice(src.indexOf("function publicStatus"), src.indexOf("export async function GET"));
  for (const banned of ["cfg.topic,", "cfg.token,", "topic:", "token:"]) {
    ok(!body.includes(banned), `the status shape never includes ${banned}`);
  }
}

console.error = origError;
console.log = origLog;
restoreNtfyEnv();

console.log(`  ${passed}/${passed + failed} ntfy assertions passed`);
if (failed) process.exit(1);
