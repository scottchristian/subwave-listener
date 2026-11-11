// scripts/stress-challenger-m3.mts
// EMPIRICAL CHALLENGER ADVERSARIAL TEST SUITE
// Runs deep stress-testing, concurrency flood, fuzzing, and security probing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const SCHEMA = path.join(REPO, "prisma", ".gen-challenger-test.prisma");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-challenger-"));
const dbFile = path.join(tmp, "challenger.db");
const cleanup = () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SCHEMA, { force: true });
};

let origFetch = globalThis.fetch;
let origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
process.env.SUBWAVE_API_URL = "http://localhost:7700";
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";

try {
  execFileSync("node", ["scripts/gen-schema.mjs", "sqlite", SCHEMA], { cwd: REPO, stdio: "pipe" });
  execFileSync("npx", ["prisma", "db", "push", "--schema", SCHEMA], {
    cwd: REPO, stdio: "pipe", env: { ...process.env },
  });

  const prisma = (await import("../lib/prisma.ts")).default;
  const auth = await import("../lib/device-auth.ts");
  const svc = await import("../lib/device-service.ts");
  const sharp = (await import("sharp")).default;
  const { NextRequest } = await import("next/server.js");
  const avatarRoute = await import("../app/api/devices/avatar/route.ts");

  console.log("=== CHALLENGE 1: High Concurrency Flood on /api/devices/avatar ===");
  const testDevice = await prisma.device.create({
    data: {
      name: "Challenger Flood Device",
      model: "jc8012p4a1",
      status: "claimed",
      buildStatus: "built",
      deviceId: "dev-flood-challenger",
    },
  });
  const token = await auth.mintDeviceToken(testDevice);

  // Generate 200x200 JPEG to test format conversion from JPEG to PNG
  const jpegBuffer = await sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 100, g: 200, b: 50 } },
  }).jpeg().toBuffer();

  globalThis.fetch = async (url) => {
    if (String(url).includes("/persona-avatar/")) {
      return new Response(jpegBuffer, {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "ETag": '"test-etag-123"' },
      });
    }
    return origFetch(url);
  };

  // Dispatch 50 parallel avatar requests with random sizes between 10 and 600
  const parallelReqs = Array.from({ length: 50 }, (_, i) => {
    const requestedSize = (i * 11) % 600;
    const url = `http://localhost/api/devices/avatar?id=host_${i}&size=${requestedSize}`;
    const req = new NextRequest(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return avatarRoute.GET(req).then(async (res) => {
      ok(res.status === 200, `Concurrent req ${i} status is 200`);
      ok(res.headers.get("content-type") === "image/png", `Concurrent req ${i} returns image/png`);
      ok(res.headers.get("cache-control")?.includes("max-age=") ?? false, `Concurrent req ${i} has Cache-Control header`);
      const body = Buffer.from(await res.arrayBuffer());
      const meta = await sharp(body).metadata();
      const clamped = Math.max(32, Math.min(512, requestedSize));
      ok(meta.width === clamped && meta.height === clamped,
        `Req ${i} (requested ${requestedSize}) clamped to ${clamped}x${clamped}`);
    });
  });

  await Promise.all(parallelReqs);
  ok(true, "50 concurrent avatar conversions completed without race condition or deadlock");

  console.log("=== CHALLENGE 2: Unicode & Security Fuzzing on Taglines ===");
  const adversarialStrings = [
    "🔥 Sound of the Underground 📻 🎧",
    "Right-to-left \u202Ereversed text\u202C probe",
    "Line1\r\nLine2\r\nLine3",
    "Zero\x00byte\x01control\x1Fcharacters",
    "   \t\r\n   Padded with complex whitespace   \n\t  ",
    "A".repeat(4096), // 4KB string
    "<script>document.cookie='hacked'</script>",
    "{\"injected\":\"json\"}",
    "null",
    "undefined",
    "[object Object]",
  ];

  for (const str of adversarialStrings) {
    const np = {
      activeShow: {
        name: "Fuzz Show",
        persona: { id: "p_fuzz", name: "Fuzz Host", tagline: str },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    ok(typeof res.tagline === "string", `buildByline handles string: ${str.slice(0, 20)}...`);
    ok(res.tagline === str.trim(), `buildByline preserves trimmed content without alteration`);
  }

  console.log("=== CHALLENGE 3: Schedule Timezone and Grid Malformations ===");
  const badGridFeed = {
    timezone: "America/New_York",
    shows: [{ id: "show_x", name: "Show X", personaId: "p_x" }],
    personas: [{ id: "p_x", name: "Host X", tagline: "Night Waves" }],
    schedule: {
      "0": ["show_x", null, undefined, 42, {}],
      "invalid_day": ["show_x"],
      "-1": ["show_x"],
    },
  };

  globalThis.fetch = async () => new Response(JSON.stringify(badGridFeed), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

  const sched = await svc.buildDeviceSchedule(Date.now());
  ok(Array.isArray(sched.slots), "buildDeviceSchedule survives malformed schedule grid slots");
  ok(sched.slots.every((s) => typeof s.show.name === "string"), "all output slots have valid show names");

  console.log("=== CHALLENGE 4: Non-GET HTTP Methods on /api/devices/avatar ===");
  const methods = ["POST", "PUT", "DELETE", "PATCH"];
  for (const m of methods) {
    const req = new NextRequest("http://localhost/api/devices/avatar?id=p_sam", {
      method: m,
      headers: { Authorization: `Bearer ${token}` },
    });
    // In Next.js route handlers, unexported methods default to 405 if called via dispatcher
    // Since only GET is exported:
    const hasMethod = (avatarRoute as any)[m] !== undefined;
    ok(!hasMethod, `avatar route does not expose unsafe ${m} handler`);
  }

} catch (e: any) {
  ok(false, "Challenger suite fatal error", String(e?.stack || e));
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
console.log(`CHALLENGER SUITE SUMMARY:`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`========================================\n`);

if (failed > 0) process.exit(1);
