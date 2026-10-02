// End-to-end test for the in-app updater. Spins nothing up itself — it drives a
// station already running in docker (see Dockerfile.e2e, e2e/entrypoint.sh) and
// asserts every stage through the real HTTP API with a real admin session.
//
// Usage (from the repo root):
//   E2E_BASE=http://127.0.0.1:3100 E2E_TOKEN=e2e-test-session-token node e2e/drive-update.mjs
//
// The scenarios, in order:
//   1. preflight sane, current version reported
//   2. start without confirm → 409 (backend unreachable here, so the room reads
//      unknown — exactly the refuse-unless-confirmed path)
//   3. start with confirm → pipeline runs against a sabotaged build:
//      backup + validation logged, download + swap happen, build fails,
//      auto-rollback restores and rebuilds, job says rolled-back... via the
//      FAILED path (status failed + rollback attempted in-process)
//   4. repair the sabotage, manual rollback route → station bounces back
//   5. real update to the main branch tip → done, site 200, updater routes gone
//      (proves the source tree was actually swapped for v0.0.2)
//
// Sabotage/unsabotage and file assertions run through `docker exec` (see
// E2E_CONTAINER). Nothing is pushed to GitHub; no tags or branches are created.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BASE = process.env.E2E_BASE || "http://127.0.0.1:3100";
const TOKEN = process.env.E2E_TOKEN || "e2e-test-session-token";
const CONTAINER = process.env.E2E_CONTAINER || "subwave-e2e";
const cookie = `next-auth.session-token=${TOKEN}`;

let passed = 0;
let failed = 0;
function ok(cond, name, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON (404 pages etc.)
  }
  return { status: res.status, json, text };
}

async function exec(cmd, args) {
  const { stdout } = await run("docker", ["exec", CONTAINER, cmd, ...args], { timeout: 120000 });
  return stdout.trim();
}

async function waitFor(cond, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await cond();
      if (v) return v;
    } catch {
      // server restarting — keep polling
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  ok(false, label, "timed out");
  return null;
}

// ---- 0. station is up ----
await waitFor(
  async () => (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10000) }).then((r) => r.status).catch(() => 0)) === 200,
  "station serves 200"
);

// ---- 1. preflight + version ----
{
  const { status, json } = await api("GET", "/api/admin/update");
  ok(status === 200, "status route 200");
  ok(typeof json.current === "string" && json.current.length > 0, "current version reported", json.current);
  ok(json.preflight && json.preflight.tarOk === true, "preflight: tar present");
  ok(json.preflight && json.preflight.npmOk === true, "preflight: npm resolved");
  ok(json.preflight && json.preflight.prismaOk === true, "preflight: prisma CLI present");
  ok(json.preflight && json.preflight.diskOk === true, "preflight: disk floor passes");
}

// ---- 2. gate: unknown room refuses without confirm ----
{
  const { status, json } = await api("POST", "/api/admin/update", { channel: "main" });
  ok(status === 409, "update without confirm refused (409)");
  ok(json && json.needsConfirm === true, "refusal carries needsConfirm");
}

// ---- 3. sabotage the build, then update: auto-rollback must repair ----
await exec("mv", ["/app/node_modules/.bin/next", "/app/node_modules/.bin/next.HIDDEN"]);
{
  const { status, json } = await api("POST", "/api/admin/update", { channel: "main", confirmListeners: true });
  ok(status === 200 && json.started === true, "update started with confirm");
}
{
  const job = await waitFor(async () => {
    const { json } = await api("GET", "/api/admin/update");
    const j = json && json.job;
    return j && (j.status === "rolled-back" || j.status === "failed") ? j : null;
  }, "pipeline settles after failed build");
  if (job) {
    const log = job.log.join("\n");
    ok(job.backupId !== null && job.backupId.length > 5, "backup taken before the failure", job.backupId);
    ok(/backup validated/.test(log), "backup validated before use");
    ok(/rolling back|rolled-back|rollback/i.test(log + (job.error || "")), "rollback recorded", (job.error || "").slice(0, 100));
    ok(job.status === "rolled-back", "job ends rolled-back (not failed)", job.status);
    const backups = await exec("ls", ["/app/data/backups"]);
    ok(backups.split("\n").some((d) => d === job.backupId), "pre-update backup on disk");
    const snap = await exec("stat", ["-c", "%s", "/app/data/update-source-snapshot.tar.gz"]).catch(() => "");
    ok(Number(snap) > 1024, "source snapshot archive on disk", `${snap} bytes`);
  }
}

// ---- 4. repair + manual rollback route ----
await exec("mv", ["/app/node_modules/.bin/next.HIDDEN", "/app/node_modules/.bin/next"]);
{
  // The failed run already rolled back in-process; this exercises the manual
  // route itself against the same material.
  const { status, json } = await api("POST", "/api/admin/update/rollback", { confirm: true });
  ok(status === 200 && json.started === true, "manual rollback starts");
  await waitFor(async () => {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    return r && r.status === 200 ? true : null;
  }, "station back after manual rollback");
  const { status: s2 } = await api("GET", "/api/admin/update");
  ok(s2 === 200, "update routes still served (develop tree restored)");
}

// ---- 5. real update to the main tip ----
// Wait for the manual rollback's bounce to complete first: the site can answer
// 200 from the pre-bounce process while the job still says running, and
// starting here would 409 (or worse, interleave two pipelines).
await waitFor(
  async () => {
    const { json } = await api("GET", "/api/admin/update");
    return json && json.job && json.job.status !== "running" ? true : null;
  },
  "rollback job settled before step 5",
  120
);
// Then prove the bounce behind it finished: three consecutive healthy reads.
// One 200 can come from the pre-bounce process; three in a row cannot.
{
  let healthy = 0;
  for (let i = 0; i < 40 && healthy < 3; i++) {
    try {
      const { status } = await api("GET", "/api/admin/update");
      healthy = status === 200 ? healthy + 1 : 0;
    } catch {
      healthy = 0;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  ok(healthy >= 3, "post-rollback process stable before step 5");
}
{
  const { status, json } = await api("POST", "/api/admin/update", { channel: "main", confirmListeners: true });
  ok(status === 200 && json.started === true, "update to main started");
  const job = await waitFor(
    async () => {
      const { json: j } = await api("GET", "/api/admin/update");
      return j && j.job && j.job.status === "done" ? j.job : null;
    },
    "update reaches done",
    150
  );
  if (job) {
    ok(/backup validated/.test(job.log.join("\n")), "second run also validated its backup");
    ok(job.to.startsWith("main@"), "job records branch + sha", job.to);
  }
  await waitFor(async () => {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    return r && r.status === 200 ? true : null;
  }, "station serves 200 on the new tree");
  // v0.0.2 predates the updater: its absence proves the source actually swapped.
  const r = await api("GET", "/api/admin/update");
  ok(r.status === 404, "updater routes gone after moving to v0.0.2 tree (swap proof)");
  const jobFile = await exec("cat", ["/app/data/update-job.json"]);
  const saved = JSON.parse(jobFile);
  ok(saved.status === "done", "job file on disk says done");
  const source = JSON.parse(await exec("cat", ["/app/data/update-source.json"]));
  ok(source.channel === "main" && typeof source.sha === "string", "source record written", JSON.stringify(source).slice(0, 80));
}

console.log(`\n  ${passed}/${passed + failed} e2e assertions passed`);
if (failed) process.exitCode = 1;
