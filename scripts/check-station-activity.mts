// Run: node --import ./scripts/test-register.mjs scripts/check-station-activity.mts
// Real activity files and real routes/auth; only their external services are
// stubbed. All storage (including child-process reads) lives in an OS temp tree.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import * as activity from "../lib/station-activity.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const originalDir = process.env.STATION_STATS_DIR;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-station-activity-"));
const T = Date.now();
const empty = { signedIn: [], listening: [], devices: [] };
const copy = await import(`${new URL("../lib/station-activity.ts", import.meta.url).href}?independent-copy`);
let count = 0;
let dirCount = 0;
async function test(label: string, fn: () => Promise<void>) {
  await fn();
  count++;
  console.log(`  PASS ${label}`);
}
async function newDir() {
  const dir = path.join(tmp, `case-${++dirCount}`);
  process.env.STATION_STATS_DIR = dir;
  return dir;
}
const liveDir = (dir: string) => path.join(dir, "activity-live");
const nameOf = (kind: string, id: string) => `${kind}-${createHash("sha256").update(`${kind}\0${id}`).digest("hex")}.json`;
const recordPath = (dir: string, kind: string, id: string) => path.join(liveDir(dir), nameOf(kind, id));
async function payload(file: string) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function privateFile(file: string, text: string) { await fs.writeFile(file, text, { mode: 0o600 }); }
async function age(file: string, at: number) { await fs.utimes(file, at / 1000, at / 1000); }
async function childRead(dir: string, now: number) {
  const source = `import {readStationActivity} from ${JSON.stringify(new URL("../lib/station-activity.ts", import.meta.url).href)};
    process.stdout.write(JSON.stringify(await readStationActivity(${now})));`;
  return JSON.parse(execFileSync(process.execPath, ["--import", path.join(REPO, "scripts/test-register.mjs"), "--input-type=module", "-e", source], {
    cwd: REPO, env: { ...process.env, STATION_STATS_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
}

try {
  await test("missing storage is unknown and untouched streams never create it", async () => {
    const dir = await newDir();
    // Never-recorded storage must not look like a measured zero.
    await assert.rejects(activity.readStationActivity(T));
    const stream = activity.trackAppStream("u1", "no-audio");
    await stream.stop();
    await stream.touch(T);
    await assert.rejects(activity.readStationActivity(T, dir));
    await assert.rejects(fs.stat(dir), { code: "ENOENT" });
  });

  await test("durable distinct identities, shared-copy serialization and restart", async () => {
    const dir = await newDir();
    await Promise.all([
      activity.recordSignedIn("u1", T), copy.recordSignedIn("u1", T + 1), activity.recordSignedIn("u1", T),
      copy.recordSignedIn("u2", T), activity.recordDeviceOnline("d1", T), copy.recordDeviceOnline("d1", T + 1),
    ]);
    const a = activity.trackAppStream("u1", "s1");
    const b = copy.trackAppStream("u1", "s2");
    const c = activity.trackAppStream("u3", "s3");
    await Promise.all([a.touch(T), b.touch(T), c.touch(T)]);
    const expected = { signedIn: ["u1", "u2", "u3"], listening: ["u1", "u3"], devices: ["d1"] };
    assert.deepEqual(await copy.readStationActivity(T + 1, dir), expected);
    assert.deepEqual(await childRead(dir, T + 1), expected);
    assert.equal((await payload(recordPath(dir, "signed-in", "u1"))).at, T + 1);
    await a.stop();
    assert.deepEqual(await activity.readStationActivity(T + 1), expected);
    await b.stop();
    assert.deepEqual((await activity.readStationActivity(T + 1)).listening, ["u3"]);
    await c.stop();
    assert.deepEqual(await activity.readStationActivity(T + 1), { signedIn: ["u1", "u2"], listening: [], devices: ["d1"] });
  });

  await test("120s presence / 30s delivered stream / 90s device exact expiry boundaries", async () => {
    await newDir();
    await activity.recordSignedIn("present", T);
    await activity.recordDeviceOnline("screen", T);
    await activity.trackAppStream("playing", "session").touch(T);
    assert.deepEqual(await activity.readStationActivity(T + 29_999), { signedIn: ["playing", "present"], listening: ["playing"], devices: ["screen"] });
    assert.deepEqual(await activity.readStationActivity(T + 30_000), { signedIn: ["present"], listening: [], devices: ["screen"] });
    assert.deepEqual((await activity.readStationActivity(T + 89_999)).devices, ["screen"]);
    assert.deepEqual((await activity.readStationActivity(T + 90_000)).devices, []);
    assert.deepEqual((await activity.readStationActivity(T + 119_999)).signedIn, ["present"]);
    assert.deepEqual(await activity.readStationActivity(T + 120_000), empty);
  });

  await test("first touch immediate, at most one write/15s, queued stop wins", async () => {
    const dir = await newDir();
    const stream = activity.trackAppStream("u1", "s1");
    await Promise.all(Array.from({ length: 100 }, () => stream.touch(T)));
    const file = recordPath(dir, "stream", "s1");
    const first = await fs.stat(file);
    await stream.touch(T + 14_999);
    assert.equal((await fs.stat(file)).ino, first.ino);
    assert.equal((await payload(file)).at, T);
    await stream.touch(T + 15_000);
    assert.notEqual((await fs.stat(file)).ino, first.ino); // atomic replacement
    assert.equal((await payload(file)).at, T + 15_000);
    await Promise.all([stream.touch(T + 30_000), stream.stop(), stream.stop(), stream.touch(T + 45_000)]);
    assert.deepEqual(await activity.readStationActivity(T + 45_000), empty);
    assert.deepEqual(await fs.readdir(liveDir(dir)), []);
  });

  await test("private permissions, hashed filenames and ID-only payloads", async () => {
    const dir = await newDir();
    await activity.recordSignedIn("user-id", T);
    await activity.recordDeviceOnline("device-id", T);
    await activity.trackAppStream("user-id", "session-id").touch(T);
    assert.equal((await fs.stat(liveDir(dir))).mode & 0o777, 0o700);
    const files = await fs.readdir(liveDir(dir));
    assert.equal(files.length, 3);
    for (const name of files) {
      assert.match(name, /^(signed-in|stream|device)-[a-f0-9]{64}\.json$/);
      assert.doesNotMatch(name, /user-id|device-id|session-id/);
      const file = path.join(liveDir(dir), name);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      const data = await payload(file);
      assert.deepEqual(Object.keys(data).sort(), data.kind === "stream" ? ["at", "id", "kind", "userId", "version"] : ["at", "id", "kind", "version"]);
    }
  });

  await test("future/corrupt/unknown schema and unsafe filenames throw without deletion", async () => {
    for (const problem of ["future", "json", "version", "extra-field", "wrong-hash", "unsafe-name", "oversize", "empty"]) {
      const dir = await newDir();
      await activity.recordSignedIn("u1", T);
      const file = recordPath(dir, "signed-in", "u1");
      const data = await payload(file);
      if (problem === "future") data.at = T + 1;
      if (problem === "version") data.version = 2;
      if (problem === "extra-field") data.email = "PRIVATE@example.invalid";
      if (problem === "wrong-hash") data.id = "different";
      await privateFile(file, problem === "json" ? "{" : problem === "oversize" ? "x".repeat(2049) : problem === "empty" ? "" : JSON.stringify(data));
      if (problem === "unsafe-name") await privateFile(path.join(liveDir(dir), "unexpected.json"), "{}");
      const names = await fs.readdir(liveDir(dir));
      await assert.rejects(activity.readStationActivity(T), problem);
      assert.deepEqual(await fs.readdir(liveDir(dir)), names);
      // A separate process must also reject, not lose in-memory health flags.
      assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e",
        `import {readStationActivity} from ${JSON.stringify(new URL("../lib/station-activity.ts", import.meta.url).href)}; await readStationActivity(${T});`],
      { env: { ...process.env, STATION_STATS_DIR: dir }, stdio: "pipe" }));
    }
  });

  await test("symlinks, directories, hardlinks and unreadable files are never followed or pruned", async () => {
    const outside = path.join(tmp, "outside");
    await privateFile(outside, "DO-NOT-CHANGE");
    for (const problem of ["symlink", "directory", "hardlink", "unreadable", "public"]) {
      const dir = await newDir();
      await activity.recordSignedIn("u1", T);
      const file = recordPath(dir, "signed-in", "u1");
      if (problem === "unreadable") await fs.chmod(file, 0o000);
      else if (problem === "public") await fs.chmod(file, 0o644);
      else {
        await fs.unlink(file);
        if (problem === "symlink") await fs.symlink(outside, file);
        if (problem === "directory") await fs.mkdir(file);
        if (problem === "hardlink") await fs.link(outside, file);
      }
      await assert.rejects(activity.readStationActivity(T + 500_000));
      await assert.rejects(activity.recordSignedIn("u1", T + 500_000));
      assert.equal(await fs.readFile(outside, "utf8"), "DO-NOT-CHANGE");
      assert.equal((await fs.readdir(liveDir(dir))).length, 1);
    }
    const target = path.join(tmp, "target-dir");
    await fs.mkdir(target, { mode: 0o700 });
    let dir = await newDir();
    await fs.symlink(target, dir);
    await assert.rejects(activity.readStationActivity(T));
    await assert.rejects(activity.recordDeviceOnline("d1", T));
    dir = await newDir();
    await fs.mkdir(dir);
    await fs.symlink(target, liveDir(dir));
    await assert.rejects(activity.readStationActivity(T));
    await assert.rejects(activity.recordDeviceOnline("d1", T));
    assert.deepEqual(await fs.readdir(target), []);
  });

  await test("pruning requires both expired evidence and old owned regular files", async () => {
    const dir = await newDir();
    await activity.recordSignedIn("old", T - 120_000);
    await activity.recordSignedIn("recent-file", T - 120_000);
    await activity.recordSignedIn("fresh", T);
    const old = recordPath(dir, "signed-in", "old");
    await age(old, T - 120_000);
    const fresh = recordPath(dir, "signed-in", "fresh");
    await age(fresh, T - 500_000); // Old mtime alone is not enough.
    const temp = `${old}.${randomUUID()}.tmp`;
    await privateFile(temp, await fs.readFile(old, "utf8"));
    await age(temp, T - 120_000);
    assert.deepEqual((await activity.readStationActivity(T)).signedIn, ["fresh"]);
    assert.deepEqual((await fs.readdir(liveDir(dir))).sort(), [path.basename(fresh), nameOf("signed-in", "recent-file")].sort());
    const recentTemp = `${fresh}.${randomUUID()}.tmp`;
    await privateFile(recentTemp, await fs.readFile(fresh, "utf8"));
    await assert.rejects(activity.readStationActivity(T));
    assert.ok(await fs.stat(recentTemp));
    await privateFile(recentTemp, "{");
    await age(recentTemp, T - 500_000);
    // An interrupted write older than every TTL holds no live evidence: it is
    // ignored for reads but never deleted, and must not blind the whole store.
    assert.deepEqual(await activity.readStationActivity(T + 500_000), empty);
    assert.ok(await fs.stat(recentTemp));
  });

  await test("file count is bounded; saturation never evicts fresh identities", async () => {
    const dir = await newDir();
    await fs.mkdir(liveDir(dir), { recursive: true, mode: 0o700 });
    await Promise.all(Array.from({ length: 4096 }, (_, i) => privateFile(recordPath(dir, "device", `d${i}`), JSON.stringify({ version: 1, kind: "device", id: `d${i}`, at: T }))));
    await assert.rejects(activity.recordDeviceOnline("overflow", T));
    assert.equal((await fs.readdir(liveDir(dir))).length, 4096);
    await privateFile(recordPath(dir, "device", "extra"), "{}");
    await assert.rejects(copy.readStationActivity(T + 90_000, dir));
    assert.equal((await fs.readdir(liveDir(dir))).length, 4097);
  });

  await test("failed writes stay unknown across module copies and other successful channels", async () => {
    const dir = await newDir();
    await assert.rejects(activity.recordSignedIn("not-an-id@example.invalid", T));
    await copy.recordDeviceOnline("d1", T);
    await activity.recordSignedIn("u2", T); // Another identity cannot heal u1.
    await assert.rejects(copy.readStationActivity(T, dir));
    assert.deepEqual(await copy.readStationActivity(T + 120_000, dir), empty);
  });

  // Load the real routes using the same native loader pattern as station-stats.
  // Database/session/relay services are isolated; recorder, deviceAuth, response
  // streaming and the legacy presence notifiers all run for real.
  const g = globalThis as any;
  const f = g.__activityRouteFixture = {
    session: null as any, cached: null as any, user: null as any, device: null as any,
    written: 1, revokedAfterWrite: false, deletedAfterWrite: false, deviceWrites: 0, userReads: 0, nextSession: 0,
    sessions: [] as any[], maintenance: false,
  };
  const secret = "CANARY-PRIVATE-CREDENTIAL";
  const tokenHash = createHash("sha256").update(secret).digest("hex");
  const stubs: Record<string, string> = {
    "next-auth": "export async function getServerSession() { return globalThis.__activityRouteFixture.session; }",
    "../auth/[...nextauth]/route": "export const authOptions = {};",
    "@/lib/session-cache": "export function sessionTokenFromCookies(req) { return req.cookies.get('session')?.value; } export async function cachedSession() { return globalThis.__activityRouteFixture.cached; }",
    "@/lib/pii": "export function displayEmail(p) { return p.email; } export function displayName(p) { return p.name; }",
    "@/lib/station": "export const STATION = { name: 'Test' };",
    "@/lib/subwave": `export async function getSubwaveConfig() { return {streamUrl:'http://relay.invalid/audio', stationPassword:${JSON.stringify(secret)}}; }`,
    "@/lib/device-service": "export function deviceSettingsOf(row) { return {brightness:70}; } export async function applyDeviceSettings(row) { return {settings:deviceSettingsOf(row),settingsRev:row.settingsRev}; }",
    "@/lib/firmware-ota": "export async function handleOtaHeartbeat() { return {patch:{},response:null}; }",
    "@/lib/prisma": `const f = globalThis.__activityRouteFixture;
      export default {
        user: {async findUnique() { f.userReads++; return f.user; }},
        setting: {async findUnique({where}) { return {value:where.key === 'maintenanceMode' && f.maintenance ? 'true' : ''}; }},
        streamSession: {
          async create({data}) { const row = {...data, id:'session-'+(++f.nextSession)}; f.sessions.push(row); return row; },
          async update() { return {}; }
        },
        device: {
          async findFirst({where}) { return f.device && where.tokenHash === f.device.tokenHash ? {...f.device} : null; },
          async updateMany({where}) {
            if (where.status.not !== 'revoked') throw new Error('Missing revocation condition');
            f.deviceWrites++; return {count:f.written};
          },
          async findUnique() { return f.deletedAfterWrite ? null : {...f.device, status:f.revokedAfterWrite ? 'revoked' : f.device.status}; }
        }
      };`,
  };
  const urls = Object.fromEntries(Object.entries(stubs).map(([key, source]) => [key, `data:text/javascript,${encodeURIComponent(source)}`]));
  register(`data:text/javascript,${encodeURIComponent(`const urls = ${JSON.stringify(urls)}; export function resolve(s,c,next) { return urls[s] ? {url:urls[s],shortCircuit:true} : next(s,c); }`)}`, import.meta.url);
  const { NextRequest } = await import("next/server.js");
  const presence = await import("../app/api/presence/route.ts");
  const streamRoute = await import("../app/api/stream/route.ts");
  const heartbeat = await import("../app/api/devices/heartbeat/route.ts");
  const legacy = await import("../lib/presence-live.ts");
  const appReq = () => new NextRequest("http://localhost/api/presence", { headers: { cookie: `session=${secret}` } });
  const deviceReq = (token?: string) => new NextRequest("http://localhost/api/devices/heartbeat", {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ ip: "192.0.2.123", firmwareVer: "1.0" }),
  });
  const user = { id: "app-user", userId: "app-user", isApproved: true, isAdmin: false, email: "PRIVATE@example.invalid", name: "PRIVATE-NAME" };
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    await test("presence records only approved authenticated heartbeats, keeps legacy behavior", async () => {
      await newDir();
      assert.equal((await presence.GET(appReq())).status, 401);
      f.cached = { ...user, isApproved: false };
      assert.equal((await presence.GET(appReq())).status, 401);
      await assert.rejects(activity.readStationActivity(Date.now()));
      f.cached = user;
      assert.equal((await presence.GET(appReq())).status, 200);
      assert.equal((await presence.GET(appReq())).status, 200);
      assert.deepEqual(await activity.readStationActivity(Date.now()), { signedIn: [user.id], listening: [], devices: [] });
      assert.ok(legacy.freshPresence(Date.now()).some((p) => p.userId === user.id));
    });

    await test("real bearer auth rejects absent/bad/revoked tokens, revocation races and a deleted row", async () => {
      await newDir();
      const beforeUsers = f.userReads;
      const beforePresence = legacy.freshPresence(Date.now());
      f.device = { id: "screen-1", deviceId: "hardware-1", status: "active", settingsRev: 1, tokenHash };
      assert.equal((await heartbeat.POST(deviceReq())).status, 401);
      assert.equal((await heartbeat.POST(deviceReq("wrong"))).status, 401);
      f.device.status = "revoked";
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 401);
      assert.equal(f.deviceWrites, 0);
      f.device.status = "active";
      f.written = 0;
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 401);
      f.written = 1;
      f.revokedAfterWrite = true;
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 401);
      await assert.rejects(activity.readStationActivity(Date.now()));
      f.revokedAfterWrite = false;
      f.deletedAfterWrite = true;
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 401);
      await assert.rejects(activity.readStationActivity(Date.now()));
      f.deletedAfterWrite = false;
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 200);
      assert.equal((await heartbeat.PATCH(deviceReq(secret))).status, 200);
      assert.deepEqual(await activity.readStationActivity(Date.now()), { signedIn: [], listening: [], devices: ["screen-1"] });
      assert.equal(f.userReads, beforeUsers);
      assert.deepEqual(legacy.freshPresence(Date.now()), beforePresence);
    });

    await test("unauthorized, forbidden, upstream-failed, missing/empty/error-body streams never count", async () => {
      await newDir();
      const request = () => new NextRequest("http://localhost/api/stream");
      assert.equal((await streamRoute.GET(request())).status, 401);
      f.session = { user };
      f.user = { ...user, isApproved: false };
      assert.equal((await streamRoute.GET(request())).status, 403);
      f.user = user;
      f.maintenance = true;
      assert.equal((await streamRoute.GET(request())).status, 503);
      f.maintenance = false;
      for (const mode of ["failure", "throw", "no-body", "empty", "zero-chunk", "read-error"]) {
        globalThis.fetch = async () => {
          if (mode === "throw") throw new Error("test relay unavailable");
          if (mode === "failure") return new Response("unavailable", { status: 503 });
          if (mode === "no-body") return new Response(null);
          return new Response(new ReadableStream({ start(c) {
            if (mode === "read-error") c.error(new Error("no audio"));
            else { if (mode === "zero-chunk") c.enqueue(new Uint8Array()); c.close(); }
          } }));
        };
        const res = await streamRoute.GET(request());
        await res.arrayBuffer();
        await assert.rejects(activity.readStationActivity(Date.now()), mode);
        if (["failure", "throw", "no-body"].includes(mode)) {
          assert.ok(legacy.liveStreams(Date.now()).some((s) => s.userId === user.id));
        }
      }
      assert.ok(f.sessions.length > 0); // Existing history starts still happen.
    });

    await test("only forwarded audio counts; two live tabs dedupe and one ending preserves the other", async () => {
      const dir = await newDir();
      const inputs: ReadableStreamDefaultController<Uint8Array>[] = [];
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { inputs.push(c); } }));
      const abort = new AbortController();
      const first = await streamRoute.GET(new NextRequest("http://localhost/api/stream"));
      const second = await streamRoute.GET(new NextRequest("http://localhost/api/stream", { signal: abort.signal }));
      const a = first.body!.getReader();
      const b = second.body!.getReader();
      await assert.rejects(activity.readStationActivity(Date.now()));
      for (const [i, out] of [a, b].entries()) {
        inputs[i].enqueue(new Uint8Array([1, 2, 3]));
        assert.deepEqual((await out.read()).value, new Uint8Array([1, 2, 3]));
      }
      assert.deepEqual(await activity.readStationActivity(Date.now()), { signedIn: [user.id], listening: [user.id], devices: [] });
      assert.equal((await fs.readdir(liveDir(dir))).length, 2);
      for (const name of await fs.readdir(liveDir(dir))) {
        assert.doesNotMatch(await fs.readFile(path.join(liveDir(dir), name), "utf8"), /CANARY|PRIVATE|192\.0\.2/);
      }
      await a.cancel();
      assert.deepEqual((await activity.readStationActivity(Date.now())).listening, [user.id]);
      abort.abort();
      await b.read();
      assert.deepEqual(await activity.readStationActivity(Date.now()), empty);
    });

    await test("a stalled downstream stops forwarding and expires rather than accumulating listening time", async () => {
      const dir = await newDir();
      let input!: ReadableStreamDefaultController<Uint8Array>;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { input = c; } }));
      const response = await streamRoute.GET(new NextRequest("http://localhost/api/stream"));
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      try {
        input.enqueue(new Uint8Array([1]));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual((await activity.readStationActivity(clock)).listening, [user.id]);
        const [file] = await fs.readdir(liveDir(dir));
        const first = await payload(path.join(liveDir(dir), file));
        for (let i = 0; i < 3; i++) {
          clock += 15_000;
          input.enqueue(new Uint8Array([2]));
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal((await payload(path.join(liveDir(dir), file))).at, first.at);
        assert.deepEqual(await activity.readStationActivity(clock), empty);
        await response.body!.cancel();
      } finally {
        Date.now = realNow;
      }
    });

    await test("stats failures are sanitized, never fail heartbeat/presence or interrupt audio", async () => {
      const dir = await newDir();
      await privateFile(dir, secret); // A file where the storage root must be.
      logs.length = 0;
      assert.equal((await presence.GET(appReq())).status, 200);
      assert.equal((await heartbeat.POST(deviceReq(secret))).status, 200);
      let input!: ReadableStreamDefaultController<Uint8Array>;
      globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { input = c; } }));
      const response = await streamRoute.GET(new NextRequest("http://localhost/api/stream"));
      const output = response.body!.getReader();
      input.enqueue(new Uint8Array([4, 5]));
      assert.equal(response.status, 200);
      assert.deepEqual((await output.read()).value, new Uint8Array([4, 5]));
      await assert.rejects(copy.readStationActivity(Date.now(), dir));
      input.enqueue(new Uint8Array([6]));
      assert.deepEqual((await output.read()).value, new Uint8Array([6]));
      await output.cancel();
      await assert.rejects(activity.readStationActivity(Date.now()));
      assert.ok(logs.some(([code]) => code === "STATION_ACTIVITY_PRESENCE_WRITE_FAILED"));
      assert.ok(logs.some(([code]) => code === "STATION_ACTIVITY_DEVICE_WRITE_FAILED"));
      assert.ok(logs.some(([code]) => code === "STATION_ACTIVITY_STREAM_WRITE_FAILED"));
      for (const args of logs) {
        assert.equal(args.length, 1);
        assert.match(String(args[0]), /^STATION_ACTIVITY_(PRESENCE|DEVICE|STREAM)_(WRITE|STOP)_FAILED$/);
      }
      assert.equal(await fs.readFile(dir, "utf8"), secret);
    });
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    delete g.__activityRouteFixture;
  }
  console.log(`  ${count}/${count} station-activity checks passed`);
} finally {
  if (originalDir === undefined) delete process.env.STATION_STATS_DIR;
  else process.env.STATION_STATS_DIR = originalDir;
  // Restore unreadable test files so cleanup also works on stricter platforms.
  await fs.rm(tmp, { recursive: true, force: true });
}
