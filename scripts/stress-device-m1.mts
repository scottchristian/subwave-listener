// Stress test and empirical adversarial challenge for Milestone 1:
// - Backend Device State & Avatar API Updates
//
// Run: TEST_REPO_ROOT=$PWD node --import ./scripts/test-register.mjs scripts/stress-device-m1.mts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const SCHEMA = path.join(REPO, "prisma", ".gen-stress-test.prisma");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  const msg = `FAIL: ${name}${extra ? " — " + extra : ""}`;
  failures.push(msg);
  console.error("  " + msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-stress-"));
const dbFile = path.join(tmp, "stress.db");
const cleanup = () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SCHEMA, { force: true });
};

// Move fetch reference outside try
let origFetch = globalThis.fetch;
let origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
process.env.SUBWAVE_API_URL = "http://localhost:7700";
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";

try {
  execFileSync("node", ["scripts/gen-schema.mjs", "sqlite", SCHEMA], { cwd: REPO, stdio: "pipe" });
  execFileSync("npx", ["prisma", "db", "push", "--schema", SCHEMA, "--skip-generate"], {
    cwd: REPO, stdio: "pipe", env: { ...process.env },
  });

  const prisma = (await import("../lib/prisma.ts")).default;
  const auth = await import("../lib/device-auth.ts");
  const svc = await import("../lib/device-service.ts");
  const sharp = (await import("sharp")).default;
  const { NextRequest } = await import("next/server.js");
  const avatarRoute = await import("../app/api/devices/avatar/route.ts");

  console.log("=== PART 1: Adversarial testing on buildByline() ===");

  // 1.1 Non-string taglines (numbers, booleans, objects, arrays, symbols)
  const nonStringTaglines = [
    123,
    0,
    -1,
    true,
    false,
    {},
    { text: "hello" },
    [],
    ["tagline1", "tagline2"],
    () => "tagline",
    Symbol("tagline"),
  ];

  for (const badTag of nonStringTaglines) {
    const np = {
      activeShow: {
        name: "Test Show",
        persona: { id: "p1", name: "Host", tagline: badTag },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    ok(
      res.tagline === null,
      `buildByline returns null for non-string activeShow tagline: ${typeof badTag}`,
      `got: ${JSON.stringify(res.tagline)}`
    );

    // Also test when present in schedule.personas twin
    const npNoTag = {
      activeShow: {
        name: "Test Show",
        persona: { id: "p2", name: "Host 2" },
      },
    };
    const schedTwin = {
      personas: [{ id: "p2", name: "Host 2", tagline: badTag }],
    };
    const resTwin = svc.buildByline(npNoTag, { streamIdle: false }, schedTwin);
    ok(
      resTwin.tagline === null,
      `buildByline returns null for non-string schedule twin tagline: ${typeof badTag}`,
      `got: ${JSON.stringify(resTwin.tagline)}`
    );
  }

  // 1.2 Whitespace and blank variations
  const blankTaglines = [
    "",
    "   ",
    "\t",
    "\n",
    "\r\n",
    "\n\t  \r  \v\f",
    "       \n       ",
  ];

  for (const blank of blankTaglines) {
    const np = {
      activeShow: {
        name: "Blank Tag Show",
        persona: { id: "p_blank", name: "Blank Host", tagline: blank },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    ok(
      res.tagline === null,
      `buildByline normalizes blank/whitespace tagline ${JSON.stringify(blank)} to null`,
      `got: ${JSON.stringify(res.tagline)}`
    );
  }

  // 1.3 Valid taglines with leading/trailing whitespace
  {
    const np = {
      activeShow: {
        name: "Trim Show",
        persona: { id: "p_trim", name: "Trim Host", tagline: "  \n  Real Tagline \t  " },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    ok(
      res.tagline === "Real Tagline",
      "buildByline trims leading and trailing whitespace from valid tagline",
      `got: ${JSON.stringify(res.tagline)}`
    );
  }

  // 1.4 Missing fields and malformed shapes
  const malformedInputs = [
    [null, null, null],
    [undefined, undefined, undefined],
    [{}, {}, {}],
    [{ activeShow: null }, { streamIdle: false }, { personas: null }],
    [{ activeShow: { persona: null } }, null, { personas: "not-an-array" }],
    [{ activeShow: { persona: 42 } }, null, { personas: 100 }],
    [{ dj: "not an object" }, null, null],
    [{ dj: { name: null, id: null, tagline: null } }, null, null],
  ];

  for (const [np, st, sc] of malformedInputs) {
    try {
      const res = svc.buildByline(np, st, sc);
      ok(typeof res === "object" && res !== null, "buildByline does not crash on malformed input shapes");
      ok(res.tagline === null || typeof res.tagline === "string", "tagline is string or null on malformed inputs");
    } catch (e: any) {
      ok(false, "buildByline crashed on malformed input", e?.message);
    }
  }

  // 1.5 Malformed elements inside schedule.personas array
  {
    const np = {
      activeShow: {
        name: "Show with messy personas",
        persona: { id: "p_target", name: "Target" },
      },
    };
    const sched = {
      personas: [
        null,
        undefined,
        42,
        "string",
        [],
        {},
        { id: null, name: null },
        { id: "p_target", name: "Target", tagline: "Found target" },
      ],
    };
    try {
      const res = svc.buildByline(np, { streamIdle: false }, sched);
      ok(res.tagline === "Found target", "buildByline navigates messy personas array containing primitives and nulls");
    } catch (e: any) {
      ok(false, "buildByline threw on messy personas array", e?.message);
    }
  }

  // 1.6 Cyclic structures in persona
  {
    const cyclicPersona: any = { id: "p_cyclic", name: "Cyclic", tagline: "Endless loop" };
    cyclicPersona.self = cyclicPersona;
    cyclicPersona.parent = { child: cyclicPersona };

    const np = {
      activeShow: {
        name: "Cyclic Show",
        persona: cyclicPersona,
      },
    };
    const sched = {
      personas: [cyclicPersona],
    };

    try {
      const res = svc.buildByline(np, { streamIdle: false }, sched);
      ok(res.tagline === "Endless loop", "buildByline handles cyclic persona references without recursion crash");
      ok(res.presenter === "Cyclic", "presenter name resolves cleanly with cyclic structure");
    } catch (e: any) {
      ok(false, "buildByline threw on cyclic structure", e?.message);
    }
  }

  // 1.7 Stress test: 50,000 personas in schedule.personas
  {
    const hugePersonas = [];
    for (let i = 0; i < 50_000; i++) {
      hugePersonas.push({
        id: `p_${i}`,
        name: `Persona ${i}`,
        tagline: i === 49_999 ? "Final tagline" : `Tagline ${i}`,
      });
    }

    const np = {
      activeShow: {
        name: "Scale Show",
        persona: { id: "p_49999", name: "Persona 49999" },
      },
    };

    const start = performance.now();
    const res = svc.buildByline(np, { streamIdle: false }, { personas: hugePersonas });
    const elapsedMs = performance.now() - start;

    ok(res.tagline === "Final tagline", "buildByline resolved tagline from 50,000 personas");
    ok(elapsedMs < 100, `buildByline lookup in 50k personas took ${elapsedMs.toFixed(2)}ms (< 100ms)`);
  }

  console.log("=== PART 2: Adversarial testing on buildDeviceSchedule() ===");

  // 2.1 Upstream response failure modes
  const upstreamFailures = [
    { name: "500 Internal Error", fn: async () => new Response("Server error", { status: 500 }) },
    { name: "404 Not Found", fn: async () => new Response("Not found", { status: 404 }) },
    { name: "Network throw", fn: async () => { throw new Error("Connection refused"); } },
    { name: "Empty body", fn: async () => new Response("", { status: 200 }) },
    { name: "Non-JSON body", fn: async () => new Response("<html>Bad Gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }) },
    { name: "Null JSON", fn: async () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }) },
    { name: "Empty object JSON", fn: async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) },
  ];

  for (const failure of upstreamFailures) {
    try {
      globalThis.fetch = failure.fn as any;
      const sched = await svc.buildDeviceSchedule(Date.now());
      ok(Array.isArray(sched.slots), `buildDeviceSchedule handles ${failure.name} gracefully by returning slots array`);
    } catch (e: any) {
      ok(false, `buildDeviceSchedule threw unhandled exception on ${failure.name}`, e?.message);
    }
  }

  // 2.2 Malformed host taglines in schedule feed
  const badHostTaglines = [
    12345,
    true,
    false,
    {},
    ["a", "b"],
    "   ",
    "\n\t\r",
    "",
  ];

  for (const badTag of badHostTaglines) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      timezone: "UTC",
      shows: [{ id: "s1", name: "Show 1", personaId: "h1" }],
      personas: [{ id: "h1", name: "Host 1", tagline: badTag }],
      schedule: { "0": ["s1"], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const slot = sched.slots.find((s) => s.show.id === "s1");
    ok(slot !== undefined, "found slot for s1");
    ok(
      slot?.show.tagline === null,
      `buildDeviceSchedule normalizes bad host tagline (${typeof badTag}: ${JSON.stringify(badTag)}) to null`,
      `got: ${JSON.stringify(slot?.show.tagline)}`
    );
  }

  // 2.3 Cyclic personas and shows in buildDeviceSchedule
  {
    const cyclicHost: any = { id: "h_cyc", name: "Cyclic Host", tagline: "Eternal show" };
    cyclicHost.ref = cyclicHost;

    const cyclicGuest: any = { id: "g_cyc", name: "Cyclic Guest", tagline: "Guest cyclic bio" };
    cyclicGuest.ref = cyclicGuest;

    const cyclicShow: any = { id: "s_cyc", name: "Cyclic Show", personaId: "h_cyc", guestPersonaIds: ["g_cyc"] };
    cyclicShow.self = cyclicShow;

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        timezone: "UTC",
        shows: [cyclicShow],
        personas: [cyclicHost, cyclicGuest],
        schedule: { "0": ["s_cyc"], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] },
      }),
    }) as any;

    try {
      const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
      const slot = sched.slots.find((s) => s.show.id === "s_cyc");
      ok(slot?.show.tagline === "Eternal show", "buildDeviceSchedule handles cyclic structures cleanly");
      ok(slot?.show.guests?.[0]?.name === "Cyclic Guest", "guest persona resolved cleanly");
    } catch (e: any) {
      ok(false, "buildDeviceSchedule crashed on cyclic structures", e?.message);
    }
  }

  // 2.4 Invalid timezone in schedule payload
  {
    globalThis.fetch = async () => new Response(JSON.stringify({
      timezone: "Not/A_Real_Timezone",
      shows: [{ id: "s1", name: "Show 1", personaId: "h1" }],
      personas: [{ id: "h1", name: "Host 1", tagline: "Tag" }],
      schedule: { "0": ["s1"], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    try {
      const sched = await svc.buildDeviceSchedule(Date.now());
      ok(sched.slots.length === 0, "invalid timezone falls back to empty schedule rather than crashing");
    } catch (e: any) {
      ok(false, "buildDeviceSchedule threw on invalid timezone", e?.message);
    }
  }

  // 2.5 Scale test: 10,000 shows and 10,000 personas
  {
    const shows: any[] = [];
    const personas: any[] = [];
    for (let i = 0; i < 10_000; i++) {
      shows.push({ id: `s_${i}`, name: `Show ${i}`, personaId: `p_${i}` });
      personas.push({ id: `p_${i}`, name: `Host ${i}`, tagline: `Tagline ${i}` });
    }
    const grid: Record<string, string[]> = {};
    for (let d = 0; d < 7; d++) {
      grid[String(d)] = Array(24).fill(`s_${d * 24}`);
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      timezone: "UTC",
      shows,
      personas,
      schedule: grid,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const start = performance.now();
    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const elapsedMs = performance.now() - start;

    ok(sched.slots.length > 0, "large schedule generated slots");
    ok(elapsedMs < 1000, `buildDeviceSchedule with 10k shows/personas took ${elapsedMs.toFixed(2)}ms (< 1000ms)`);
  }

  console.log("=== PART 3: Adversarial testing on /api/devices/avatar ===");

  const screenRow = await prisma.device.create({
    data: {
      name: "Challenger Test Screen",
      model: "jc8012p4a1",
      status: "claimed",
      buildStatus: "built",
      deviceId: "dev-stress-avatar",
    },
  });
  const screenToken = await auth.mintDeviceToken(screenRow);

  // In-memory 400x400 test image
  const fixturePng = await sharp({
    create: { width: 400, height: 400, channels: 4, background: { r: 50, g: 100, b: 150, alpha: 1 } },
  }).png().toBuffer();

  globalThis.fetch = async (url) => {
    if (String(url).includes("/persona-avatar/")) {
      return new Response(fixturePng, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return origFetch(url);
  };

  // 3.1 Extreme size parameters (as specified in mission)
  // Expected behavior based on clamping:
  // - MIN_SIZE = 32, MAX_SIZE = 512, DEFAULT_SIZE = 128
  // - values < 32 clamp to 32
  // - values > 512 clamp to 512
  // - NaN / invalid / empty / null fall back to DEFAULT_SIZE = 128
  const sizeCases: Array<{ raw: string | null; expectedSize: number; desc: string }> = [
    { raw: "-999999", expectedSize: 32, desc: "extreme negative number clamped to 32" },
    { raw: "99999999", expectedSize: 512, desc: "extreme positive number clamped to 512" },
    { raw: "NaN", expectedSize: 128, desc: "NaN string falls back to default 128" },
    { raw: "0", expectedSize: 32, desc: "zero clamped to 32" },
    { raw: "31", expectedSize: 32, desc: "boundary: 31 clamped to 32" },
    { raw: "32", expectedSize: 32, desc: "boundary: 32 exact min size" },
    { raw: "512", expectedSize: 512, desc: "boundary: 512 exact max size" },
    { raw: "513", expectedSize: 512, desc: "boundary: 513 clamped to 512" },
    { raw: "3.1415", expectedSize: 32, desc: "float 3.1415 parsed as 3, clamped to 32" },
    { raw: "0x100", expectedSize: 32, desc: "hex string 0x100 parsed in base 10 as 0, clamped to 32" },
    { raw: null, expectedSize: 128, desc: "null (omitted) defaults to 128" },
    { raw: "", expectedSize: 128, desc: "empty string defaults to 128" },
    { raw: "Infinity", expectedSize: 128, desc: "Infinity falls back to default 128" },
    { raw: "-Infinity", expectedSize: 128, desc: "-Infinity falls back to default 128" },
    { raw: "   ", expectedSize: 128, desc: "whitespace defaults to 128" },
    { raw: "180", expectedSize: 180, desc: "180 produces exact modal well size" },
  ];

  for (const tc of sizeCases) {
    const url = tc.raw !== null
      ? `http://localhost/api/devices/avatar?id=p_sam&size=${encodeURIComponent(tc.raw)}`
      : "http://localhost/api/devices/avatar?id=p_sam";

    const req = new NextRequest(url, {
      headers: { Authorization: `Bearer ${screenToken}` },
    });

    const res = await avatarRoute.GET(req);
    ok(res.status === 200, `avatar route returns 200 for ${tc.desc}`);

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    ok(
      meta.width === tc.expectedSize && meta.height === tc.expectedSize,
      `size=${tc.raw} produces ${tc.expectedSize}x${tc.expectedSize} PNG (${tc.desc})`,
      `actual: ${meta.width}x${meta.height}`
    );
  }

  // 3.2 Malformed persona IDs (security and injection challenge)
  // Specified in mission:
  // - id=../../etc/passwd
  // - id=../bad
  // - id=%00
  // - id=
  // Additional adversarial IDs:
  // - regex characters, length > 64, script tags, spaces
  const badIds: Array<{ id: string | null; desc: string }> = [
    { id: "../../etc/passwd", desc: "path traversal / directory traversal" },
    { id: "../bad", desc: "relative path component" },
    { id: "\u0000", desc: "null byte" },
    { id: "", desc: "empty ID" },
    { id: null, desc: "omitted ID parameter" },
    { id: "   ", desc: "whitespace ID" },
    { id: "p sam", desc: "ID with space" },
    { id: "<script>alert(1)</script>", desc: "XSS tag in ID" },
    { id: "p_sam;DROP TABLE devices;", desc: "SQL injection attempt" },
    { id: "a".repeat(65), desc: "ID exceeding 64 chars limit" },
    { id: "a".repeat(1000), desc: "Huge ID string" },
    { id: "p*sam", desc: "Glob / wildcard character" },
    { id: "p\\sam", desc: "Backslash" },
    { id: "p\nsam", desc: "Newline injection" },
  ];

  for (const bad of badIds) {
    const url = bad.id !== null
      ? `http://localhost/api/devices/avatar?id=${encodeURIComponent(bad.id)}&size=180`
      : "http://localhost/api/devices/avatar?size=180";

    const req = new NextRequest(url, {
      headers: { Authorization: `Bearer ${screenToken}` },
    });

    const res = await avatarRoute.GET(req);
    ok(
      res.status === 400,
      `malformed ID rejected with 400: ${bad.desc}`,
      `got status ${res.status}`
    );
  }

  // 3.3 Valid IDs at exact boundary limits
  {
    const valid64 = "A".repeat(64);
    const req64 = new NextRequest(`http://localhost/api/devices/avatar?id=${valid64}&size=180`, {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const res64 = await avatarRoute.GET(req64);
    ok(res64.status === 200, "valid 64-char ID accepted (boundary)");

    const validSpecial = "Valid-Persona_Id-123";
    const reqSpecial = new NextRequest(`http://localhost/api/devices/avatar?id=${validSpecial}&size=180`, {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const resSpecial = await avatarRoute.GET(reqSpecial);
    ok(resSpecial.status === 200, "valid alphanumeric with hyphen and underscore accepted");
  }

  // 3.4 Upstream errors handling in /api/devices/avatar
  // Upstream 404
  {
    globalThis.fetch = async () => new Response("Not found", { status: 404 });
    const req = new NextRequest("http://localhost/api/devices/avatar?id=p_sam", {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const res = await avatarRoute.GET(req);
    ok(res.status === 404, "upstream 404 returns 404 JSON gracefully");
  }

  // Upstream timeout or network error
  {
    globalThis.fetch = async () => { throw new Error("Connection timed out"); };
    const req = new NextRequest("http://localhost/api/devices/avatar?id=p_sam", {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const res = await avatarRoute.GET(req);
    ok(res.status === 504, "upstream network failure returns 504 Gateway Timeout");
  }

  // Upstream corrupted image buffer
  {
    globalThis.fetch = async () => new Response("not an image at all", {
      status: 200, headers: { "Content-Type": "image/png" },
    });
    const req = new NextRequest("http://localhost/api/devices/avatar?id=p_sam", {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const res = await avatarRoute.GET(req);
    ok(res.status === 504, "upstream corrupted image is caught and returns 504");
  }

  // 3.5 Security boundaries: Authentication and Revocation
  {
    // Revoked device cannot fetch avatar
    await prisma.device.update({ where: { id: screenRow.id }, data: { status: "revoked" } });
    const reqRevoked = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=180", {
      headers: { Authorization: `Bearer ${screenToken}` },
    });
    const resRevoked = await avatarRoute.GET(reqRevoked);
    ok(resRevoked.status === 401, "revoked device token rejected with 401");

    // Missing token
    const reqNoAuth = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=180");
    const resNoAuth = await avatarRoute.GET(reqNoAuth);
    ok(resNoAuth.status === 401, "missing authorization header rejected with 401");

    // Invalid bearer token
    const reqBadAuth = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=180", {
      headers: { Authorization: "Bearer bogus-token-12345" },
    });
    const resBadAuth = await avatarRoute.GET(reqBadAuth);
    ok(resBadAuth.status === 401, "bogus bearer token rejected with 401");
  }

} catch (e: any) {
  ok(false, "stress test suite fatal error", String(e?.stack || e));
} finally {
  globalThis.fetch = origFetch;
  if (origSubwaveApiUrl !== undefined) {
    process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
  } else {
    delete process.env.SUBWAVE_API_URL;
  }
  cleanup();
}

console.log(`\n========================================`);
console.log(`STRESS TEST SUMMARY:`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
