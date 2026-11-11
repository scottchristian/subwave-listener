// Run: node --import ./scripts/test-register.mjs scripts/check-station-stats.mts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import {
  CONFIG_CACHE_MS, MAX_HOLD_MS, SAMPLE_INTERVAL_MS, MAX_FILE_BYTES, MAX_ACTIVITY_IDS, getStationStats,
  persistStationObservation, startStationStatsCollector, stationDayBounds,
  summarizeStationStats, validStationTimeZone, validStationDate, StationStatsDateError,
} from "../lib/station-stats.ts";
import type { StationObservation, StationStatsCollector } from "../lib/station-stats.ts";
import type { StationStatsResponse } from "../lib/station-stats-types.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-station-stats-"));
const originalDir = process.env.STATION_STATS_DIR;
const originalPhase = process.env.NEXT_PHASE;
const workers = new Set<StationStatsCollector>();
const base = Date.parse("2026-07-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const dayMs = 86_400_000;
const sample = (at: number, listeners: number | null, onAir: boolean | null): StationObservation => ({ at: iso(at), listeners, onAir, issues: [] });
const summary = (samples: StationObservation[], now: number, timeZone: string | null = "UTC", date?: string) => summarizeStationStats({
  samples, timeZone, trackingSince: samples[0]?.at ?? null, errors: [],
}, now, date);
type Activity = NonNullable<StationObservation["activity"]>;
const emptyActivity = (): Activity => ({ signedIn: [], listening: [], devices: [] });
const activeSample = (at: number, signedIn: string[] = [], listening: string[] = [], devices: string[] = []): StationObservation => ({
  ...sample(at, 2, true), activity: { signedIn, listening, devices },
});
const idleSchedule = () => () => {};
const sourceConfig = async () => ({ apiUrl: "https://station.invalid/api/" });
const goodFetch: typeof fetch = async (url) => Response.json(String(url).endsWith("/now-playing")
  ? { listeners: { current: 2 }, streamOnline: true, timezone: "UTC" }
  : { streamIdle: false, timezone: "UTC" });
const start = (opts: Parameters<typeof startStationStatsCollector>[0]) => {
  // Every running collector gets an explicit fixture: never read real local activity.
  const worker = startStationStatsCollector({ loadActivity: async () => emptyActivity(), ...opts });
  assert.ok(worker);
  workers.add(worker);
  return worker;
};
const newDir = async (name: string) => {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  return dir;
};
let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  await run();
  passed++;
  console.log(`  PASS ${name}`);
}

try {
  delete process.env.NEXT_PHASE;
  await test("empty, missing, unreadable storage and unknown timezone never invent zero metrics", async () => {
    const dir = path.join(root, "missing");
    const out = await getStationStats({ dir, now: base });
    assert.equal(out.timeZone, null);
    assert.equal(out.dayStart, null);
    assert.equal(out.dayEnd, null);
    assert.equal(out.trackingSince, null);
    assert.equal(out.lastSampleAt, null);
    assert.deepEqual(out.current, { listeners: null, onAir: null, at: null, stale: true });
    for (const key of ["airtimeSec", "listenerSeconds", "averageListeners", "peakListeners"] as const) assert.equal(out.today[key], null);
    assert.equal(out.today.listenerObservedSec, 0);
    assert.deepEqual(out.timeline, []);
    assert.match(out.error!, /No station observations/);
    assert.match(out.error!, /timezone/);
    await fs.writeFile(dir, "not a directory");
    assert.match((await getStationStats({ dir, now: base })).error!, /storage is unreadable/);
  });

  await test("weighted intervals include measured zero; airtime is not listener time", () => {
    const out = summary([
      sample(base, 10, true), sample(base + 30_000, 0, false), sample(base + 90_000, 20, true),
      sample(base + 150_000, null, null), sample(base + 240_000, 4, false),
    ], base + 300_000);
    assert.deepEqual(out.today, {
      airtimeSec: 90, listenerSeconds: 1740, averageListeners: 1740 / 210, peakListeners: 20,
      airtimeObservedSec: 210, listenerObservedSec: 210, elapsedSec: 300,
    });
    assert.equal(out.timeline[3].listeners, null);
    assert.equal(out.error, null);
    assert.equal(out.current.listeners, 4);
    assert.equal(out.current.stale, false);
    assert.ok(out.today.listenerObservedSec < out.today.elapsedSec);
    const idle = summary([sample(base, 0, false)], base + 60_000);
    assert.equal(idle.today.airtimeSec, 0);
    assert.equal(idle.today.averageListeners, 0);
    assert.equal(idle.today.peakListeners, 0);
    assert.equal(idle.error, null);
    const listenersOnly = summary([sample(base, 8, null)], base + 60_000);
    assert.equal(listenersOnly.today.airtimeSec, null);
    assert.equal(listenersOnly.today.listenerSeconds, 480);
    const airOnly = summary([sample(base, null, true)], base + 60_000);
    assert.equal(airOnly.today.airtimeSec, 60);
    assert.equal(airOnly.today.listenerSeconds, null);
    assert.equal(airOnly.today.averageListeners, null);
  });

  await test("failed observations terminate holds; restart gaps remain unknown after 90 seconds", () => {
    const failed = summary([sample(base, 8, true), sample(base + 60_000, null, null)], base + 120_000);
    assert.equal(failed.today.airtimeSec, 60);
    assert.equal(failed.today.listenerObservedSec, 60);
    const out = summary([sample(base, 8, true), sample(base + 300_000, null, null), sample(base + 600_000, 0, false)], base + 660_000);
    assert.equal(out.today.airtimeSec, 90);
    assert.equal(out.today.airtimeObservedSec, 150);
    assert.equal(out.today.listenerSeconds, 720);
    assert.equal(out.today.averageListeners, 4.8);
    assert.ok(out.timeline.some((s) => s.at === iso(base + 90_000) && s.endAt === iso(base + 300_000) && s.onAir === null));
    assert.equal(out.timeline.reduce((sum, s) => sum + Date.parse(s.endAt) - Date.parse(s.at), 0), 660_000);
    for (let i = 1; i < out.timeline.length; i++) assert.equal(out.timeline[i - 1].endAt, out.timeline[i].at);
  });

  await test("freshness boundary, future samples, peak points and midnight carry are explicit", () => {
    assert.equal(summary([sample(base, 5, true)], base + MAX_HOLD_MS).current.stale, false);
    const stale = summary([sample(base, 5, true)], base + MAX_HOLD_MS + 1);
    assert.deepEqual(stale.current, { listeners: null, onAir: null, at: iso(base), stale: true });
    const out = summary([sample(base - 30_000, 4, true)], base + 30_000);
    assert.equal(out.current.at, iso(base - 30_000));
    assert.equal(out.dayStart, iso(base));
    assert.equal(out.dayEnd, iso(base + dayMs));
    assert.equal(out.today.airtimeSec, 30);
    assert.equal(out.today.listenerSeconds, 120);
    assert.equal(out.today.peakListeners, 4);
    assert.equal(out.timeline[0].at, iso(base));
    const point = summary([sample(base, 7, true)], base);
    assert.equal(point.today.peakListeners, 7);
    assert.equal(point.today.averageListeners, null);
    assert.equal(point.today.airtimeSec, null);
    assert.equal(summary([sample(base + 10_000, 99, true)], base).lastSampleAt, null);
    assert.equal(summary([sample(base - MAX_HOLD_MS, 99, true)], base).today.peakListeners, null);
  });

  await test("Hobart and New York local calendars span both 23-hour and 25-hour DST days", () => {
    const cases = [
      ["America/New_York", "2026-03-08T12:00:00Z", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
      ["America/New_York", "2026-11-01T12:00:00Z", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25],
      ["Australia/Hobart", "2026-10-04T01:00:00Z", "2026-10-03T14:00:00Z", "2026-10-04T13:00:00Z", 23],
      ["Australia/Hobart", "2026-04-05T01:00:00Z", "2026-04-04T13:00:00Z", "2026-04-05T14:00:00Z", 25],
    ] as const;
    for (const [zone, now, expectedStart, expectedEnd, hours] of cases) {
      const { start, end } = stationDayBounds(Date.parse(now), zone);
      assert.equal(start, Date.parse(expectedStart));
      assert.equal(end, Date.parse(expectedEnd));
      assert.equal((end - start) / 3_600_000, hours);
      const out = summary([sample(start - 30_000, 3, true)], start + 30_000, zone);
      assert.equal(out.today.elapsedSec, 30);
      assert.equal(out.today.listenerObservedSec, 30);
    }
    for (const invalid of [undefined, null, "", "not/a-zone", "+10:00", 123]) assert.equal(validStationTimeZone(invalid), null);
    assert.equal(validStationTimeZone("Australia/Hobart"), "Australia/Hobart");
  });

  await test("selected historical calendars cover DST, UTC+14 and UTC-12 without 24-hour assumptions", () => {
    const cases = [
      ["America/New_York", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23],
      ["America/New_York", "2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25],
      ["Australia/Hobart", "2026-10-04", "2026-10-03T14:00:00Z", "2026-10-04T13:00:00Z", 23],
      ["Australia/Hobart", "2026-04-05", "2026-04-04T13:00:00Z", "2026-04-05T14:00:00Z", 25],
      ["Pacific/Kiritimati", "2026-07-01", "2026-06-30T10:00:00Z", "2026-07-01T10:00:00Z", 24],
      ["Etc/GMT+12", "2026-07-01", "2026-07-01T12:00:00Z", "2026-07-02T12:00:00Z", 24],
    ] as const;
    for (const [zone, date, expectedStart, expectedEnd, hours] of cases) {
      const start = Date.parse(expectedStart);
      const end = Date.parse(expectedEnd);
      const now = end + 3 * dayMs;
      assert.deepEqual(stationDayBounds(now, zone, date), { start, end });
      const out = summary([activeSample(start - 30_000, ["u1"], ["u1"], ["d1"]),
        activeSample(end - 30_000, ["u2"], [], ["d2"])], now, zone, date);
      assert.equal(out.date, date);
      assert.equal(out.isToday, false);
      assert.equal(out.generatedAt, iso(now));
      assert.equal(out.dayStart, iso(start));
      assert.equal(out.dayEnd, iso(end));
      assert.equal(out.today.elapsedSec, hours * 3600);
      assert.equal(out.today.listenerObservedSec, 90);
      assert.equal(out.activity.observedSec, 90);
      assert.equal(out.activity.signedInSeconds, 90);
      assert.equal(out.activity.listeningSeconds, 60);
      assert.deepEqual(out.activity.users, [{ userId: "u1", signedInSec: 60, listeningSec: 60 }, { userId: "u2", signedInSec: 30, listeningSec: 0 }]);
      assert.equal(out.timeline[0].at, iso(start));
      assert.equal(out.timeline.at(-1)!.endAt, iso(end));
      assert.equal(out.timeline.reduce((sum, point) => sum + Date.parse(point.endAt) - Date.parse(point.at), 0), end - start);
    }
  });

  await test("historical current/peak exclude all later days and are not stale due to age", () => {
    const first = activeSample(base + 60_000, ["u1"], ["u1"], ["d1"]);
    const end = activeSample(base + dayMs - 30_000, ["u2"], [], ["d2"]);
    const later = { ...activeSample(base + dayMs, ["u3", "u4"], ["u3"], ["d3", "d4", "d5"]), listeners: 999,
      issues: ["now_playing_unavailable"] as StationObservation["issues"] };
    const out = summary([first, end, later], base + 3 * dayMs, "UTC", "2026-07-01");
    assert.equal(out.current.stale, false);
    assert.equal(out.current.at, end.at);
    assert.equal(out.lastSampleAt, end.at);
    assert.equal(out.current.listeners, 2);
    assert.equal(out.today.peakListeners, 2);
    assert.equal(out.today.listenerSeconds, 240);
    assert.equal(out.activity.signedInSeconds, 120);
    assert.equal(out.activity.listeningSeconds, 90);
    assert.equal(out.activity.uniqueDevices, 2);
    assert.equal(out.activity.peakDevices, 1);
    assert.equal(out.activity.averageDevices, 1);
    assert.deepEqual(out.activity.current, { signedIn: 1, listening: 0, devicesOnline: 1 });
    assert.equal(out.error, null);
    assert.equal(out.activity.error, null);
    const today = summary([first], base + 150_001);
    assert.equal(today.current.stale, true);
    assert.deepEqual(today.activity.current, { signedIn: null, listening: null, devicesOnline: null });
    assert.match(today.activity.error!, /stale/);
    const historicalEarly = summary([first], base + 3 * dayMs, "UTC", "2026-07-01");
    assert.equal(historicalEarly.current.stale, false);
    assert.equal(historicalEarly.current.listeners, 2);
    assert.equal(historicalEarly.error, null);
  });

  await test("unknown past days have full local bounds and unknown coverage, not invented zeros", () => {
    const out = summary([activeSample(base, ["u1"], [], ["d1"])], base + 30_000, "UTC", "2026-06-28");
    assert.equal(out.dayStart, "2026-06-28T00:00:00.000Z");
    assert.equal(out.dayEnd, "2026-06-29T00:00:00.000Z");
    assert.equal(out.today.elapsedSec, 86400);
    assert.equal(out.lastSampleAt, null);
    assert.equal(out.today.peakListeners, null);
    assert.equal(out.activity.observedSec, 0);
    for (const key of ["signedInSeconds", "listeningSeconds", "peakDevices", "averageDevices", "uniqueDevices"] as const) assert.equal(out.activity[key], null);
    assert.deepEqual(out.activity.users, []);
    assert.deepEqual(out.activity.current, { signedIn: null, listening: null, devicesOnline: null });
    assert.deepEqual(out.timeline, [{ at: out.dayStart, endAt: out.dayEnd, listeners: null, onAir: null, signedIn: null, listening: null, devicesOnline: null }]);
    assert.deepEqual(out.availableDates, ["2026-07-01"]);
    assert.equal(out.todayDate, "2026-07-01");
  });

  await test("distinct user unions, device peak/mean/unique, failures and zero share exactly held intervals", () => {
    const points = [
      activeSample(base, ["u1", "u1", "u2"], ["u1", "u1"], ["d1", "d1", "d2"]),
      activeSample(base + 30_000, ["u1", "u3"], ["u1", "u2", "u2"], ["d2", "d3"]),
      { ...sample(base + 90_000, 7, false), activity: null },
      activeSample(base + 150_000),
      activeSample(base + 300_000, ["u2"], ["u2"], ["d4"]),
    ];
    const out = summary(points, base + 360_000);
    assert.equal(out.activity.observedSec, 240);
    assert.equal(out.activity.signedInSeconds, 240);
    assert.equal(out.activity.listeningSeconds, 210);
    assert.equal(out.activity.peakDevices, 2);
    assert.equal(out.activity.averageDevices, 1);
    assert.equal(out.activity.uniqueDevices, 4);
    assert.deepEqual(out.activity.users, [
      { userId: "u1", signedInSec: 90, listeningSec: 90 },
      { userId: "u2", signedInSec: 90, listeningSec: 120 },
      { userId: "u3", signedInSec: 60, listeningSec: 0 },
    ]);
    assert.equal(out.activity.users.reduce((n, u) => n + u.signedInSec, 0), out.activity.signedInSeconds);
    assert.equal(out.activity.users.reduce((n, u) => n + u.listeningSec, 0), out.activity.listeningSeconds);
    assert.equal(out.timeline[2].signedIn, null);
    assert.equal(out.timeline[2].listeners, 7);
    assert.equal(out.timeline[3].devicesOnline, 0);
    assert.ok(out.timeline.some((p) => p.at === iso(base + 240_000) && p.endAt === iso(base + 300_000) && p.signedIn === null));
    assert.equal(out.error, null);
    assert.equal(out.activity.error, null);
    const noActivity = summary([activeSample(base, ["u1"]), sample(base + 30_000, 2, true)], base + 90_000);
    assert.equal(noActivity.activity.observedSec, 30);
    assert.equal(noActivity.activity.signedInSeconds, 30);
    assert.equal(noActivity.activity.current.signedIn, null);
    const future = summary([activeSample(base + 1, ["u1"], [], ["d1"])], base);
    assert.equal(future.activity.uniqueDevices, null);
    assert.equal(future.activity.trackingSince, null);
    // A valid sample observed exactly now has no held duration yet but still peaks.
    const atNow = summary([activeSample(base + 60_000, [], [], ["d1", "d2"])], base + 60_000);
    assert.equal(atNow.activity.peakDevices, 2);
    assert.equal(atNow.activity.uniqueDevices, 2);
    assert.equal(atNow.activity.observedSec, 0);
    assert.equal(atNow.activity.averageDevices, null);
    const expiredCarry = summary([activeSample(base - MAX_HOLD_MS, ["u1"], [], ["d1"])], base + 1);
    assert.equal(expiredCarry.activity.uniqueDevices, null);
    assert.equal(expiredCarry.activity.observedSec, 0);
  });

  await test("old version-one records stay unknown while measured empty sets mean known zero", async () => {
    const dir = await newDir("activity-migration");
    const file = path.join(dir, "station-stats-2026-07-01.json");
    const metadata = { trackingSince: iso(base), timeZone: "UTC" };
    await fs.writeFile(file, JSON.stringify({ version: 1, day: "2026-07-01", ...metadata, samples: [sample(base, 9, true)] }), { mode: 0o644 });
    let out = await getStationStats({ dir, now: base + 60_000 });
    assert.equal(out.today.listenerSeconds, 540);
    assert.equal(out.activity.trackingSince, null);
    assert.equal(out.activity.observedSec, 0);
    assert.equal(out.activity.signedInSeconds, null);
    assert.equal(out.activity.peakDevices, null);
    assert.deepEqual(out.activity.users, []);
    assert.equal(out.timeline[0].signedIn, null);
    await persistStationObservation(activeSample(base + 60_000), metadata, dir);
    out = await getStationStats({ dir, now: base + 120_000 });
    assert.equal(out.today.listenerSeconds, 660);
    assert.equal(out.activity.trackingSince, iso(base + 60_000));
    assert.equal(out.activity.observedSec, 60);
    assert.equal(out.activity.signedInSeconds, 0);
    assert.equal(out.activity.listeningSeconds, 0);
    assert.equal(out.activity.uniqueDevices, 0);
    assert.equal(out.activity.peakDevices, 0);
    assert.equal(out.activity.averageDevices, 0);
    assert.deepEqual(out.activity.current, { signedIn: 0, listening: 0, devicesOnline: 0 });
    assert.equal(out.activity.error, null);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(Object.hasOwn(saved.samples[0], "activity"), false);
    assert.deepEqual(saved.samples[1].activity, emptyActivity());
  });

  await test("collector captures injected activity before HTTP waits; station and activity failures remain independent", async () => {
    const dir = await newDir("activity-collector");
    let clock = base;
    let failActivity = false;
    let malformedActivity = false;
    let failStation = false;
    const events: string[] = [];
    const worker = start({ dir, now: () => clock, schedule: idleSchedule,
      loadActivity: async (at, baseDir) => {
        events.push("activity");
        assert.equal(at, clock);
        assert.equal(baseDir, dir);
        if (failActivity) throw new Error("SECRET local I/O failure");
        if (malformedActivity) return { signedIn: ["email@example.com"], listening: [], devices: [] };
        return { signedIn: ["u1", "u1", "u2"], listening: ["u1", "u1"], devices: ["d1", "d1"] };
      },
      loadConfig: async () => { events.push("config"); return sourceConfig(); },
      fetch: async (...args) => {
        events.push("http");
        clock += 10_000;
        if (failStation) throw new Error("SECRET source failure");
        return goodFetch(...args);
      },
    });
    await worker.poll();
    assert.deepEqual(events, ["activity", "config", "http", "http"]);
    let out = await getStationStats({ dir, now: clock });
    assert.equal(out.lastSampleAt, iso(base));
    assert.deepEqual(out.activity.current, { signedIn: 2, listening: 1, devicesOnline: 1 });
    assert.equal(out.activity.signedInSeconds, 40);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "station-stats-2026-07-01.json"), "utf8"));
    assert.deepEqual(saved.samples[0].activity, { signedIn: ["u1", "u2"], listening: ["u1"], devices: ["d1"] });
    clock = base + 60_000;
    failStation = true;
    await worker.poll();
    out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.listeners, null);
    assert.equal(out.activity.current.signedIn, 2);
    assert.equal(out.activity.current.devicesOnline, 1);
    assert.equal(out.activity.error, null);
    assert.match(out.error!, /observation failed/);
    clock = base + 120_000;
    failStation = false;
    failActivity = true;
    await worker.poll();
    out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.listeners, 2);
    assert.equal(out.error, null);
    assert.equal(worker.error, null);
    assert.equal(out.activity.current.signedIn, null);
    assert.equal(out.activity.observedSec, 120);
    assert.match(out.activity.error!, /activity observation failed/);
    assert.doesNotMatch(JSON.stringify(out), /SECRET/);
    clock = base + 180_000;
    failActivity = false;
    malformedActivity = true;
    await worker.poll();
    out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.listeners, 2);
    assert.equal(out.error, null);
    assert.match(out.activity.error!, /activity observation failed/);
    const raw = await fs.readFile(path.join(dir, "station-stats-2026-07-01.json"), "utf8");
    assert.doesNotMatch(raw, /SECRET|email@example/);
    assert.equal(JSON.parse(raw).samples[2].activity, null);
    assert.equal(JSON.parse(raw).samples[3].activity, null);
    await worker.stop();
  });

  await test("live count validation, idle/online truth table and partial source failures", async () => {
    const dir = await newDir("source");
    let clock = base;
    let np: unknown = { listeners: { current: 0 }, streamOnline: true, timezone: "Australia/Hobart", secret: "DO-NOT-PERSIST" };
    let state: unknown = { streamIdle: false };
    let failNP = false;
    let failState = false;
    let configCalls = 0;
    const worker = start({ dir, now: () => clock, schedule: idleSchedule,
      loadConfig: async () => { configCalls++; return sourceConfig(); },
      fetch: async (url, init) => {
        assert.equal(init?.cache, "no-store");
        assert.ok(init?.signal);
        assert.ok(String(url).startsWith("https://station.invalid/api/"));
        const isNP = String(url).endsWith("/now-playing");
        if (isNP ? failNP : failState) throw new Error("SECRET source credentials");
        return Response.json(isNP ? np : state);
      },
    });
    await worker.poll();
    assert.equal((await getStationStats({ dir, now: clock })).current.listeners, 0);
    for (const [count, expected] of [[5, 5], [0, 0], [-1, null], [1.5, null], [NaN, null], [Infinity, null], ["7", null], [null, null], [undefined, null]] as const) {
      clock += SAMPLE_INTERVAL_MS;
      np = { listeners: { current: count }, streamOnline: true, timezone: "bogus" };
      await worker.poll();
      const out = await getStationStats({ dir, now: clock });
      assert.equal(out.current.listeners, expected);
      assert.equal(out.timeZone, "Australia/Hobart");
      assert.equal(out.current.onAir, true);
    }
    for (const [idle, online, expected] of [
      [false, true, true], [true, true, false], [true, false, false], [false, false, false],
      [undefined, false, false], [true, undefined, false], [false, undefined, null],
      [undefined, true, null], [undefined, undefined, null], ["false", "true", null],
    ] as const) {
      clock += SAMPLE_INTERVAL_MS;
      state = { streamIdle: idle };
      np = { streamOnline: online, nowPlaying: { startedAt: iso(base) }, activeShow: { startedAt: iso(base) } };
      await worker.poll();
      assert.equal((await getStationStats({ dir, now: clock })).current.onAir, expected);
    }
    clock += SAMPLE_INTERVAL_MS;
    failNP = true;
    state = { streamIdle: true };
    await worker.poll();
    let out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.onAir, false);
    assert.equal(out.current.listeners, null);
    assert.match(out.error!, /Now-playing observation failed/);
    clock += SAMPLE_INTERVAL_MS;
    failNP = false;
    failState = true;
    np = { listeners: { current: 9 }, streamOnline: true };
    await worker.poll();
    out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.listeners, 9);
    assert.equal(out.current.onAir, null);
    clock += SAMPLE_INTERVAL_MS;
    failNP = true;
    await worker.poll();
    out = await getStationStats({ dir, now: clock });
    assert.equal(out.current.listeners, null);
    assert.equal(out.current.onAir, null);
    assert.equal(out.current.stale, false);
    assert.equal(configCalls, 1);
    assert.doesNotMatch(await fs.readFile(path.join(dir, "station-stats-2026-07-01.json"), "utf8"), /SECRET|DO-NOT-PERSIST|startedAt|userId/);
    await worker.stop();
  });

  await test("malformed HTTP/JSON responses cannot masquerade as observations", async () => {
    const dir = await newDir("malformed-source");
    let clock = base;
    let response = () => new Response("unavailable", { status: 503 });
    const worker = start({ dir, now: () => clock, schedule: idleSchedule, loadConfig: sourceConfig,
      fetch: async () => response(),
    });
    await worker.poll();
    for (const make of [() => new Response("{broken"), () => Response.json(null), () => Response.json([])]) {
      clock += 60_000;
      response = make;
      await worker.poll();
      const out = await getStationStats({ dir, now: clock + 1_000 });
      assert.equal(out.current.listeners, null);
      assert.equal(out.current.onAir, null);
      assert.equal(out.timeZone, null);
      assert.match(out.error!, /observation failed/);
    }
    await worker.stop();
  });

  await test("local today integrates two UTC files and clips the preceding local-day sample", async () => {
    const dir = await newDir("utc-boundary");
    const first = Date.parse("2026-06-30T13:59:30Z");
    const second = Date.parse("2026-06-30T23:59:30Z");
    const third = Date.parse("2026-07-01T00:00:30Z");
    const metadata = { trackingSince: iso(first), timeZone: "Australia/Hobart" };
    await persistStationObservation(sample(first, 1, true), metadata, dir);
    await persistStationObservation(sample(second, 2, true), metadata, dir);
    await persistStationObservation(sample(third, 4, false), metadata, dir);
    const out = await getStationStats({ dir, now: third + 30_000 });
    assert.equal(out.dayStart, "2026-06-30T14:00:00.000Z");
    assert.equal(out.dayEnd, "2026-07-01T14:00:00.000Z");
    assert.equal(out.today.listenerObservedSec, 150);
    assert.equal(out.today.airtimeSec, 120);
    assert.equal(out.today.listenerSeconds, 300);
    assert.equal(out.today.averageListeners, 2);
    assert.equal(out.current.listeners, 4);
    assert.equal((await fs.readdir(dir)).length, 2);
  });

  await test("hourly config cache, duplicate startup/polls, durable restart and timezone recovery", async () => {
    const dir = await newDir("restart");
    let clock = base;
    let configCalls = 0;
    let fetches = 0;
    let scheduled = 0;
    let cancelled = 0;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const opts = { dir, now: () => clock,
      schedule: (_tick: () => void, ms: number) => { scheduled++; assert.equal(ms, 60_000); return () => { cancelled++; }; },
      loadConfig: async () => { configCalls++; await blocked; return sourceConfig(); },
      fetch: (async (...args: Parameters<typeof fetch>) => { fetches++; return goodFetch(...args); }) as typeof fetch,
    };
    const worker = start(opts);
    assert.equal(startStationStatsCollector(opts), worker);
    const reloaded = await import(new URL("../lib/station-stats.ts?startup-guard", import.meta.url).href);
    assert.equal(reloaded.startStationStatsCollector(opts), worker);
    const a = worker.poll();
    assert.equal(worker.poll(), a);
    unblock();
    await a;
    assert.equal(scheduled, 1);
    assert.equal(fetches, 2);
    await worker.poll();
    assert.equal(fetches, 2);
    for (let i = 1; i <= 60; i++) {
      clock = base + i * SAMPLE_INTERVAL_MS;
      await worker.poll();
      assert.equal(configCalls, i === 60 ? 2 : 1);
    }
    await worker.stop();
    assert.equal(cancelled, 1);
    clock += 10 * SAMPLE_INTERVAL_MS;
    const restarted = start({ dir, now: () => clock, schedule: idleSchedule, loadConfig: sourceConfig,
      fetch: async () => { throw new Error("unavailable"); },
    });
    await restarted.poll();
    const out = await getStationStats({ dir, now: clock + 30_000 });
    assert.equal(out.trackingSince, iso(base));
    assert.equal(out.timeZone, "UTC");
    assert.equal(out.current.listeners, null);
    assert.ok(out.timeline.some((s) => s.at === iso(base + CONFIG_CACHE_MS + MAX_HOLD_MS) && s.listeners === null));
    await restarted.stop();
    const saved = JSON.parse(await fs.readFile(path.join(dir, "station-stats-2026-07-01.json"), "utf8"));
    assert.equal(saved.samples.length, 62);
    process.env.STATION_STATS_DIR = dir;
    assert.equal((await getStationStats({ now: clock })).trackingSince, iso(base));
  });

  await test("production build never starts a timer or reads config", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    assert.equal(startStationStatsCollector({ loadConfig: async () => { throw new Error("must not run"); },
      schedule: () => { throw new Error("must not schedule"); } }), null);
    delete process.env.NEXT_PHASE;
  });

  await test("request and hung config deadlines persist null samples without minute DB retries", async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, ms === 10_000 ? 10 : ms, ...args)) as typeof setTimeout;
    try {
      const dir = await newDir("timeout");
      let clock = base;
      const signals: AbortSignal[] = [];
      const worker = start({ dir, now: () => clock, schedule: idleSchedule, loadConfig: sourceConfig,
        fetch: async (_url, init) => { signals.push(init!.signal!); return new Promise<Response>(() => {}); },
      });
      await worker.poll();
      assert.equal(signals.length, 2);
      assert.ok(signals.every((signal) => signal.aborted));
      assert.equal((await getStationStats({ dir, now: clock })).current.listeners, null);
      await worker.stop();
      const configDir = await newDir("config-timeout");
      let loads = 0;
      const hung = start({ dir: configDir, now: () => clock, schedule: idleSchedule,
        loadConfig: () => { loads++; return new Promise(() => {}); }, fetch: goodFetch,
      });
      await hung.poll();
      for (const delta of [60_000, 120_000, CONFIG_CACHE_MS]) {
        clock = base + delta;
        await hung.poll();
      }
      assert.equal(loads, 1);
      assert.match((await getStationStats({ dir: configDir, now: clock })).error!, /configuration is unavailable/);
      await hung.stop();
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  await test("real short timer positively collects, does not overlap, and stops cleanly", async () => {
    const dir = await newDir("real-timer");
    let clock = base;
    let polls = 0;
    let requests = 0;
    let maxRequests = 0;
    let timer: ReturnType<typeof setInterval>;
    let ready!: () => void;
    const enough = new Promise<void>((resolve) => { ready = resolve; });
    const worker = start({ dir, now: () => clock, loadConfig: sourceConfig,
      schedule: (tick, ms) => {
        assert.equal(ms, 60_000);
        timer = setInterval(() => { clock += 60_000; tick(); }, 5);
        return () => clearInterval(timer);
      },
      fetch: async (...args) => {
        requests++;
        maxRequests = Math.max(maxRequests, requests);
        await new Promise((resolve) => setTimeout(resolve, 12));
        requests--;
        if (String(args[0]).endsWith("/state") && ++polls >= 3) ready();
        return goodFetch(...args);
      },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([enough, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("collector timer did not fire")), 2000); })]);
    } finally {
      if (deadline) clearTimeout(deadline);
      await worker.stop();
    }
    assert.ok(polls >= 3);
    assert.equal(maxRequests, 2);
    assert.equal(requests, 0);
    const files = await fs.readdir(dir);
    const saved = JSON.parse(await fs.readFile(path.join(dir, files[0]), "utf8"));
    assert.ok(saved.samples.length >= 3);
    const before = polls;
    await worker.poll();
    assert.equal(polls, before);
  });

  await test("atomic rename/write failures preserve prior data and expose collector persistence errors", async () => {
    const dir = await newDir("atomic");
    const metadata = { trackingSince: iso(base), timeZone: "UTC" };
    await persistStationObservation(sample(base, 3, true), metadata, dir);
    const file = path.join(dir, "station-stats-2026-07-01.json");
    const before = await fs.readFile(file, "utf8");
    const realRename = fs.rename;
    fs.rename = async (from, to) => {
      assert.equal(String(to), file);
      assert.equal(await fs.readFile(file, "utf8"), before);
      assert.equal(JSON.parse(await fs.readFile(from, "utf8")).samples.length, 2);
      throw Object.assign(new Error("SECRET rename failure"), { code: "ENOSPC" });
    };
    try {
      await assert.rejects(persistStationObservation(sample(base + 60_000, 77, false), metadata, dir));
      assert.equal(await fs.readFile(file, "utf8"), before);
      assert.equal((await getStationStats({ dir, now: base + 60_000 })).current.listeners, 3);
      const realWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args) => { warnings.push(args.join(" ")); };
      try {
        const worker = start({ dir, now: () => base + 60_000, schedule: idleSchedule, loadConfig: sourceConfig, fetch: goodFetch });
        await worker.poll();
        await worker.poll();
        assert.match((await getStationStats({ dir, now: base + 60_000 })).error!, /could not be persisted/);
        assert.doesNotMatch(warnings.join(" "), /SECRET/);
        assert.match(warnings.join(" "), /ENOSPC/);
        await worker.stop();
      } finally { console.warn = realWarn; }
    } finally { fs.rename = realRename; }
    const realOpen = fs.open;
    fs.open = async () => { throw new Error("write failed"); };
    try { await assert.rejects(persistStationObservation(sample(base + 60_000, 77, false), metadata, dir)); }
    finally { fs.open = realOpen; }
    assert.deepEqual(await fs.readdir(dir), [path.basename(file)]);
    assert.equal(await fs.readFile(file, "utf8"), before);
    await persistStationObservation(sample(base + 60_000, 4, false), metadata, dir);
    await persistStationObservation(sample(base + 60_001, 5, false), metadata, dir);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).samples.length, 2);
  });

  await test("failed writes never start activity tracking before the first persisted snapshot", async () => {
    const dir = await newDir("activity-first-write-failure");
    let clock = base;
    const realRename = fs.rename;
    const realWarn = console.warn;
    fs.rename = async () => { throw new Error("failed first write"); };
    console.warn = () => {};
    let worker: StationStatsCollector;
    try {
      worker = start({ dir, now: () => clock, schedule: idleSchedule, loadConfig: sourceConfig, fetch: goodFetch });
      await worker.poll();
      assert.match(worker.error!, /could not be persisted/);
    } finally { fs.rename = realRename; console.warn = realWarn; }
    clock += 60_000;
    await worker!.poll();
    const out = await getStationStats({ dir, now: clock + 30_000 });
    assert.equal(out.activity.trackingSince, iso(clock));
    assert.equal(out.activity.observedSec, 30);
    assert.equal(out.activity.signedInSeconds, 0);
    assert.equal(worker!.error, null);
    await worker!.stop();
  });

  await test("corrupt/oversized/invalid files yield unknown coverage and are not overwritten", async () => {
    const dir = await newDir("corruption");
    const file = path.join(dir, "station-stats-2026-07-01.json");
    const valid = { version: 1, day: "2026-07-01", trackingSince: iso(base), timeZone: "UTC", samples: [sample(base, 2, true)] };
    for (const contents of ["", "{broken", " ".repeat(MAX_FILE_BYTES + 1), JSON.stringify({ ...valid, samples: [sample(base, -1, true)] }),
      JSON.stringify({ ...valid, samples: [sample(base, 2, true), sample(base + 1, 2, true)] }),
      JSON.stringify({ ...valid, timeZone: "invalid" }),
      JSON.stringify({ ...valid, samples: Array(1441).fill(sample(base, 2, true)) }),
      JSON.stringify({ ...valid, samples: [{ ...sample(base, 2, true), issues: ["SECRET"] }] }),
    ]) {
      await fs.writeFile(file, contents);
      const out = await getStationStats({ dir, now: base + 60_000 });
      assert.equal(out.today.airtimeSec, null);
      assert.equal(out.current.listeners, null);
      assert.match(out.error!, /unreadable/);
      assert.doesNotMatch(out.error!, /SECRET/);
      await assert.rejects(persistStationObservation(sample(base + 60_000, 4, true), { trackingSince: iso(base), timeZone: "UTC" }, dir));
      assert.equal(await fs.readFile(file, "utf8"), contents);
    }
  });

  await test("activity validation rejects malformed IDs and excessive cardinality without truncating", async () => {
    const dir = await newDir("activity-validation");
    const metadata = { trackingSince: iso(base), timeZone: "UTC" };
    const file = path.join(dir, "station-stats-2026-07-01.json");
    await persistStationObservation(activeSample(base, ["u1", "u1"], ["u1"], ["d1", "d1"]), metadata, dir);
    const before = await fs.readFile(file, "utf8");
    const valid = JSON.parse(before);
    const invalid = [undefined, [], { signedIn: [], listening: [] }, { ...emptyActivity(), email: "private@example.com" },
      { ...emptyActivity(), signedIn: ["private@example.com"] }, { ...emptyActivity(), devices: ["name with spaces"] },
      { ...emptyActivity(), signedIn: [1] }, { ...emptyActivity(), listening: ["x".repeat(129)] },
      { ...emptyActivity(), devices: [""] }, { ...emptyActivity(), devices: Array.from({ length: MAX_ACTIVITY_IDS + 1 }, (_, i) => `d${i}`) },
    ];
    for (const activity of invalid) {
      await assert.rejects(persistStationObservation({ ...sample(base + 60_000, 2, true), activity } as StationObservation, metadata, dir), /activity|Activity/);
      assert.equal(await fs.readFile(file, "utf8"), before);
      // Undefined is not representable in JSON; absence deliberately remains a valid old record.
      if (activity !== undefined) {
        await fs.writeFile(file, JSON.stringify({ ...valid, samples: [{ ...sample(base, 2, true), activity }] }));
        const out = await getStationStats({ dir, now: base + 30_000 });
        assert.match(out.error!, /unreadable/);
        assert.equal(out.activity.current.signedIn, null);
        assert.equal(out.activity.observedSec, 0);
        await fs.writeFile(file, before);
      }
    }
    assert.deepEqual(JSON.parse(before).samples[0].activity, { signedIn: ["u1"], listening: ["u1"], devices: ["d1"] });
  });

  await test("1440 activity samples exceed the old byte limit safely; oversized writes fail before replacing history", async () => {
    const dir = await newDir("activity-size");
    const file = path.join(dir, "station-stats-2026-07-01.json");
    const metadata = { trackingSince: iso(base), timeZone: "UTC" };
    const ids = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(24, "0")}`);
    const samples = Array.from({ length: 1440 }, (_, i) => activeSample(base + i * 60_000, ids, ids, ids));
    const daily = { version: 1, day: "2026-07-01", ...metadata, samples };
    const contents = JSON.stringify(daily);
    assert.ok(Buffer.byteLength(contents) > 512 * 1024);
    assert.ok(Buffer.byteLength(contents) < MAX_FILE_BYTES);
    await fs.writeFile(file, contents);
    const out = await getStationStats({ dir, now: base + dayMs, date: "2026-07-01" });
    assert.equal(out.activity.observedSec, 86400);
    assert.equal(out.activity.signedInSeconds, 20 * 86400);
    assert.equal(out.activity.users.length, 20);
    assert.equal(out.activity.users.reduce((n, u) => n + u.listeningSec, 0), 20 * 86400);
    assert.equal(out.activity.uniqueDevices, 20);
    assert.equal(out.activity.averageDevices, 20);
    assert.equal(out.error, null);
    const longIds = Array.from({ length: MAX_ACTIVITY_IDS }, (_, i) => `d${String(i).padStart(127, "0")}`);
    const huge = activeSample(base, longIds, longIds, longIds);
    const hugeBytes = Buffer.byteLength(JSON.stringify(huge));
    const count = Math.floor((MAX_FILE_BYTES - 1000) / (hugeBytes + 1));
    const packed = { ...daily, samples: Array.from({ length: count }, (_, i) => ({ ...huge, at: iso(base + i * 60_000) })) };
    const packedContents = JSON.stringify(packed);
    assert.ok(Buffer.byteLength(packedContents) < MAX_FILE_BYTES);
    await fs.writeFile(file, packedContents);
    await assert.rejects(persistStationObservation({ ...huge, at: iso(base + count * 60_000) }, metadata, dir), /size limit exceeded/);
    assert.equal(await fs.readFile(file, "utf8"), packedContents);
    assert.deepEqual(await fs.readdir(dir), [path.basename(file)]);
  });

  await test("available dates use persisted station-local observations and stay inside 32 calendar days", async () => {
    for (const [zone, expected] of [["Pacific/Kiritimati", "2026-07-02"], ["Etc/GMT+12", "2026-07-01"]] as const) {
      const dir = await newDir(`available-${expected}`);
      const at = base + 23 * 3_600_000;
      const metadata = { trackingSince: iso(at - 40 * dayMs), timeZone: zone };
      await persistStationObservation(sample(at - 40 * dayMs, 2, true), metadata, dir);
      await persistStationObservation(sample(at - 31 * dayMs, 2, true), metadata, dir);
      await persistStationObservation(sample(at, 2, true), metadata, dir);
      const out = await getStationStats({ dir, now: at });
      assert.equal(out.todayDate, expected);
      assert.equal(out.availableDates[0], expected);
      assert.equal(out.availableDates.length, 2);
      assert.equal(out.availableDates[1], iso(Date.parse(`${expected}T00:00:00Z`) - 31 * dayMs).slice(0, 10));
      const old = await getStationStats({ dir, now: at, date: iso(at - 40 * dayMs).slice(0, 10) });
      assert.equal(old.today.peakListeners, null);
      assert.equal(old.current.listeners, null);
    }
    const out = summary(Array.from({ length: 40 }, (_, i) => sample(base - i * dayMs, 2, true)), base, "Pacific/Kiritimati");
    assert.equal(out.availableDates.length, 32);
    assert.equal(out.availableDates[0], "2026-07-01");
    assert.equal(out.availableDates.at(-1), "2026-05-31");
  });

  await test("activity tracking metadata survives long downtime, retention, restart and a failed new snapshot", async () => {
    const dir = await newDir("activity-long-restart");
    const oldest = base - 40 * dayMs;
    await persistStationObservation(activeSample(oldest, ["u1"], [], ["d1"]), { trackingSince: iso(oldest), timeZone: "UTC" }, dir);
    let worker = start({ dir, now: () => base, schedule: idleSchedule, loadConfig: sourceConfig, fetch: goodFetch,
      loadActivity: async () => { throw new Error("unreadable activity"); } });
    await worker.poll();
    await worker.stop();
    let out = await getStationStats({ dir, now: base + 30_000 });
    assert.equal(out.activity.trackingSince, iso(oldest));
    assert.equal(out.activity.observedSec, 0);
    assert.equal(out.activity.uniqueDevices, null);
    assert.deepEqual(await fs.readdir(dir), ["station-stats-2026-07-01.json"]);
    worker = start({ dir, now: () => base + dayMs, schedule: idleSchedule, loadConfig: sourceConfig, fetch: goodFetch });
    await worker.poll();
    await worker.stop();
    out = await getStationStats({ dir, now: base + dayMs + 30_000 });
    assert.equal(out.activity.trackingSince, iso(oldest));
    assert.equal(out.activity.current.signedIn, 0);
    assert.equal(out.activity.signedInSeconds, 0);
  });

  await test("today's collector failure does not taint historical data but real storage errors remain visible", async () => {
    const dir = await newDir("historical-errors");
    const metadata = { trackingSince: iso(base), timeZone: "UTC" };
    await persistStationObservation(activeSample(base, ["u1"], [], ["d1"]), metadata, dir);
    const realOpen = fs.open;
    const realWarn = console.warn;
    fs.open = async () => { throw new Error("failed persistence"); };
    console.warn = () => {};
    let worker: StationStatsCollector;
    try {
      worker = start({ dir, now: () => base + dayMs, schedule: idleSchedule, loadConfig: sourceConfig, fetch: goodFetch });
      await worker.poll();
    } finally { fs.open = realOpen; console.warn = realWarn; }
    const old = await getStationStats({ dir, now: base + dayMs, date: "2026-07-01" });
    assert.equal(old.error, null);
    assert.equal(old.activity.error, null);
    assert.equal(old.current.stale, false);
    assert.equal(old.activity.signedInSeconds, 90);
    assert.match((await getStationStats({ dir, now: base + dayMs })).error!, /could not be persisted/);
    await fs.writeFile(path.join(dir, "station-stats-2026-07-02.json"), "{broken");
    const corrupt = await getStationStats({ dir, now: base + dayMs, date: "2026-07-01" });
    assert.match(corrupt.error!, /unreadable/);
    assert.match(corrupt.activity.error!, /unreadable/);
    assert.equal(corrupt.today.listenerSeconds, 180);
    await worker!.stop();
  });

  await test("retention deletes only old owned regular files and preserves original tracking metadata", async () => {
    const dir = await newDir("retention");
    const oldest = base - 40 * dayMs;
    const metadata = { trackingSince: iso(oldest), timeZone: "UTC" };
    await persistStationObservation(sample(oldest, 2, true), metadata, dir);
    await persistStationObservation(sample(base - 31 * dayMs, 2, true), metadata, dir);
    const oldName = `station-stats-${iso(oldest).slice(0, 10)}.json`;
    const oldTemp = `${oldName}.00000000-0000-0000-0000-000000000000.tmp`;
    const keep = ["notes.json", "station-stats-2026-02-30.json", `${oldName}.backup`, "station-stats-2026-05-01.json"];
    for (const name of keep.slice(0, -1)) await fs.writeFile(path.join(dir, name), "untouched");
    await fs.mkdir(path.join(dir, keep.at(-1)!));
    const link = "station-stats-2026-05-02.json";
    await fs.symlink(path.join(dir, "notes.json"), path.join(dir, link));
    await fs.writeFile(path.join(dir, oldTemp), "partial");
    await persistStationObservation(sample(base, 2, true), metadata, dir);
    const names = await fs.readdir(dir);
    assert.ok(!names.includes(oldName));
    assert.ok(!names.includes(oldTemp));
    assert.ok(names.includes(`station-stats-${iso(base - 31 * dayMs).slice(0, 10)}.json`));
    for (const name of [...keep, link]) assert.ok(names.includes(name));
    assert.equal((await getStationStats({ dir, now: base })).trackingSince, iso(oldest));
    const restartDir = await newDir("long-restart");
    await persistStationObservation(sample(oldest, 2, true), metadata, restartDir);
    const worker = start({ dir: restartDir, now: () => base, schedule: idleSchedule, loadConfig: sourceConfig,
      fetch: async () => { throw new Error("offline"); },
    });
    await worker.poll();
    const restarted = await getStationStats({ dir: restartDir, now: base });
    assert.equal(restarted.trackingSince, iso(oldest));
    assert.equal(restarted.timeZone, "UTC");
    assert.equal(restarted.current.listeners, null);
    assert.equal(restarted.today.listenerObservedSec, 0);
    await worker.stop();
  });

  await test("admin route denies unauthenticated callers, is no-store, and never fetches on GET", async () => {
    const dir = await newDir("route");
    process.env.STATION_STATS_DIR = dir;
    await persistStationObservation(sample(base, 0, false), { trackingSince: iso(base), timeZone: "UTC" }, dir);
    const globals = globalThis as typeof globalThis & { __stationStatsAdmin?: boolean; __stationStatsAuthCalls?: number };
    const mockUrl = `data:text/javascript,${encodeURIComponent("export async function requireAdmin() { globalThis.__stationStatsAuthCalls = (globalThis.__stationStatsAuthCalls || 0) + 1; return globalThis.__stationStatsAdmin ? { id: 'NOT-IN-RESPONSE' } : null; }")}`;
    const hook = `export function resolve(specifier, context, next) { if (specifier === '@/lib/admin-auth') return { url: ${JSON.stringify(mockUrl)}, shortCircuit: true }; return next(specifier, context); }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
    const route = await import("../app/api/admin/station-stats/route.ts");
    const realFetch = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = async () => { throw new Error("GET must not fetch"); };
    Date.now = () => base + 30_000;
    try {
      globals.__stationStatsAdmin = false;
      let res = await route.GET();
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      globals.__stationStatsAdmin = true;
      res = await route.GET();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-store");
      const out: StationStatsResponse = await res.json();
      assert.equal(out.today.averageListeners, 0);
      assert.equal(out.today.airtimeSec, 0);
      assert.equal(out.current.listeners, 0);
      assert.doesNotMatch(JSON.stringify(out), /NOT-IN-RESPONSE/);
      assert.equal(globals.__stationStatsAuthCalls, 2);
      for (const date of ["", "2026-7-01", "2026-07-1", "2026-02-29", "2026-02-30", "1900-02-29", "2100-02-29",
        "0000-01-01", "2026-13-01", "2026-00-01", "2026-07-00", "2026-07-32", "2026-07-01T00:00:00Z", " 2026-07-01", "2026-07-01 ", "not-a-date"]) {
        assert.equal(validStationDate(date), false, date);
        await assert.rejects(getStationStats({ dir, now: base, date }), StationStatsDateError);
        const invalid = await route.GET(new Request(`https://app.invalid/api/admin/station-stats?date=${encodeURIComponent(date)}`));
        assert.equal(invalid.status, 400, date);
        assert.equal(invalid.headers.get("Cache-Control"), "no-store");
      }
      for (const query of ["date=2026-07-02", "date=9999-12-31", "date=2026-07-01&date=2026-07-01"]) {
        res = await route.GET(new Request(`https://app.invalid/api/admin/station-stats?${query}`));
        assert.equal(res.status, 400, query);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
      }
      for (const date of ["2000-02-29", "2024-02-29", "2026-06-30", "2026-07-01"]) {
        assert.equal(validStationDate(date), true);
        res = await route.GET(new Request(`https://app.invalid/api/admin/station-stats?date=${date}`));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
        const selected: StationStatsResponse = await res.json();
        assert.equal(selected.date, date);
        assert.equal(selected.todayDate, "2026-07-01");
        assert.equal(selected.isToday, date === "2026-07-01");
        assert.equal(selected.dayStart, `${date}T00:00:00.000Z`);
        if (!selected.isToday) {
          assert.equal(selected.today.elapsedSec, 86400);
          assert.equal(selected.activity.signedInSeconds, null);
          assert.equal(selected.current.listeners, null);
          assert.equal(selected.timeline.length, 1);
        }
      }
      globals.__stationStatsAdmin = false;
      const realRead = fs.readdir;
      fs.readdir = async () => { throw new Error("Unauthenticated GET must not read storage"); };
      try {
        res = await route.GET(new Request("https://app.invalid/api/admin/station-stats?date=bad"));
        assert.equal(res.status, 403);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
      } finally { fs.readdir = realRead; }
      globals.__stationStatsAdmin = true;
      // Future validation follows the station's calendar, not UTC/server/browser local dates.
      Date.now = () => base + 23 * 3_600_000;
      for (const [zone, todayDate, futureDate] of [["Pacific/Kiritimati", "2026-07-02", "2026-07-03"], ["Etc/GMT+12", "2026-07-01", "2026-07-02"]]) {
        await persistStationObservation(sample(base, 0, false), { trackingSince: iso(base), timeZone: zone }, dir);
        res = await route.GET(new Request(`https://app.invalid/api/admin/station-stats?date=${todayDate}`));
        assert.equal(res.status, 200);
        assert.equal((await res.json()).todayDate, todayDate);
        res = await route.GET(new Request(`https://app.invalid/api/admin/station-stats?date=${futureDate}`));
        assert.equal(res.status, 400);
        assert.equal(res.headers.get("Cache-Control"), "no-store");
      }
      assert.equal(route.runtime, "nodejs");
      assert.equal(route.dynamic, "force-dynamic");
    } finally {
      globalThis.fetch = realFetch;
      Date.now = realNow;
      delete globals.__stationStatsAdmin;
      delete globals.__stationStatsAuthCalls;
    }
  });
} finally {
  await Promise.all([...workers].map((worker) => worker.stop()));
  if (originalDir === undefined) delete process.env.STATION_STATS_DIR;
  else process.env.STATION_STATS_DIR = originalDir;
  if (originalPhase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = originalPhase;
  await fs.rm(root, { recursive: true, force: true });
}
console.log(`  ${passed}/${passed} station statistics checks passed`);
