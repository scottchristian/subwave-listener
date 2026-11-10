// Empirical Challenger Test Harness for Milestone 1 (Backend Multi-Host & Edge Cases)
// Challenger Agent: challenger_m1_backend_1
//
// Run: TEST_REPO_ROOT=$PWD node --import ./scripts/test-register.mjs scripts/stress-challenger-m1.mts

import path from "node:path";
import fs from "node:fs";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  const msg = `FAIL: ${name}${detail ? " — " + detail : ""}`;
  failures.push(msg);
  console.error("  " + msg);
}

const origFetch = globalThis.fetch;
const origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
process.env.SUBWAVE_API_URL = "http://localhost:7700";

try {
  const svc = await import("../lib/device-service.ts");
  const types = await import("../lib/device-types.ts");

  console.log("=== EMPIRICAL CHALLENGER: PART 1 — Edge Cases & Malformed Inputs in buildByline() ===");

  // 1.1 Null / Undefined / Primitive inputs to buildByline
  const strangeInputs = [
    [null, null, null],
    [undefined, undefined, undefined],
    [{}, {}, {}],
    ["string", 123, true],
    [[], [], []],
    [{ activeShow: null }, { streamIdle: false }, null],
    [{ activeShow: "not-an-object" }, { streamIdle: "yes" }, { personas: null }],
    [{ activeShow: { persona: null, guests: null } }, null, { personas: null }],
    [{ activeShow: { persona: 999, guests: [null, undefined, 42, {}] } }, null, null],
    [{ dj: null }, null, null],
    [{ dj: "DJ String" }, null, null],
    [{ dj: { name: 123 } }, null, null],
  ];

  for (let i = 0; i < strangeInputs.length; i++) {
    const [np, st, sc] = strangeInputs[i];
    try {
      const res = svc.buildByline(np as any, st as any, sc as any);
      assert(res !== null && typeof res === "object", `buildByline returns valid object for strange input #${i}`);
      assert(Array.isArray(res.presenters!), `res.presenters! is array for strange input #${i}`);
      assert(res.tagline === null || typeof res.tagline === "string", `res.tagline is string|null for strange input #${i}`);
    } catch (e: any) {
      assert(false, `buildByline threw on strange input #${i}`, e?.message);
    }
  }

  // 1.2 Whitespace-only taglines (must strictly return null)
  const whitespaceTaglines = [
    "",
    " ",
    "   ",
    "\t",
    "\n",
    "\r",
    "\r\n",
    " \t \r \n \v \f ",
    "\u00A0", // non-breaking space
    "   \u00A0 \t   ",
  ];

  for (const ws of whitespaceTaglines) {
    // Test on activeShow.persona
    const np = {
      activeShow: {
        name: "WS Test",
        persona: { id: "p_ws", name: "Host WS", tagline: ws },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    assert(res.tagline === null, `buildByline host tagline with whitespace ${JSON.stringify(ws)} resolves to null`);
    assert(res.presenters![0]?.tagline === null, `buildByline presenter[0].tagline with whitespace resolves to null`);

    // Test on guest
    const npGuest = {
      activeShow: {
        name: "WS Guest Test",
        persona: { id: "p_h", name: "Host" },
        guests: [{ id: "g_ws", name: "Guest WS", tagline: ws }],
      },
    };
    const resGuest = svc.buildByline(npGuest, { streamIdle: false }, null);
    assert(resGuest.presenters![1]?.tagline === null, `buildByline guest tagline with whitespace ${JSON.stringify(ws)} resolves to null`);

    // Test on schedule persona lookup
    const npLookup = {
      activeShow: {
        name: "WS Lookup Test",
        persona: { id: "p_lookup", name: "Host Lookup" },
      },
    };
    const sched = {
      personas: [{ id: "p_lookup", name: "Host Lookup", tagline: ws }],
    };
    const resLookup = svc.buildByline(npLookup, { streamIdle: false }, sched);
    assert(resLookup.tagline === null, `buildByline schedule twin tagline with whitespace resolves to null`);
  }

  // 1.3 Non-string taglines (numbers, booleans, objects, arrays, functions, symbols)
  const nonStringValues = [
    0,
    1,
    -100,
    3.14,
    true,
    false,
    {},
    { tagline: "nested" },
    [],
    ["tag1", "tag2"],
    () => "hi",
    Symbol("tag"),
    BigInt(100),
  ];

  for (const ns of nonStringValues) {
    const np = {
      activeShow: {
        name: "NonString Test",
        persona: { id: "p_ns", name: "Host NS", tagline: ns },
      },
    };
    const res = svc.buildByline(np, { streamIdle: false }, null);
    assert(res.tagline === null, `buildByline non-string tagline (${typeof ns}) resolves to null`);
    assert(res.presenters![0]?.tagline === null, `presenter[0].tagline non-string (${typeof ns}) resolves to null`);

    // Test on guest
    const npGuest = {
      activeShow: {
        name: "NonString Guest Test",
        persona: { id: "p_h", name: "Host" },
        guests: [{ id: "g_ns", name: "Guest NS", tagline: ns }],
      },
    };
    const resGuest = svc.buildByline(npGuest, { streamIdle: false }, null);
    assert(resGuest.presenters![1]?.tagline === null, `guest.tagline non-string (${typeof ns}) resolves to null`);
  }

  // 1.4 Guest IDs NOT in schedule personas
  console.log("=== EMPIRICAL CHALLENGER: PART 2 — Guest IDs NOT in Personas ===");
  {
    const np = {
      activeShow: {
        name: "Show with Unknown Guests",
        persona: { id: "p_host", name: "Real Host", tagline: "Host Tag" },
        guests: [
          { id: "ghost_1", name: "Unregistered Guest 1", tagline: "Ghost Tag 1" },
          { id: "ghost_2", name: "Unregistered Guest 2" }, // no tagline
          "ghost_3", // string guest
          { id: "ghost_4" }, // no name, only id
        ],
        guestPersonaIds: ["ghost_5", "ghost_6"],
      },
    };
    const sched = {
      shows: [
        { id: "s_unk", name: "Show with Unknown Guests", guestPersonaIds: ["ghost_7", "ghost_1"] },
      ],
      personas: [
        { id: "p_host", name: "Real Host", tagline: "Host Tag" },
      ],
    };

    const res = svc.buildByline(np, { streamIdle: false }, sched);
    assert(res.presenters!.length > 0, "buildByline handles unregistered guests without crashing");
    
    // Check host
    assert(res.presenters![0].id === "p_host" && res.presenters![0].role === "Host", "Host resolved properly");

    // Check ghost_1
    const g1 = res.presenters!.find(p => p.id === "ghost_1");
    assert(g1 !== undefined, "ghost_1 exists in presenters");
    assert(g1?.name === "Unregistered Guest 1", "ghost_1 name preserved");
    assert(g1?.role === "Guest", "ghost_1 default role is Guest");
    assert(g1?.tagline === "Ghost Tag 1", "ghost_1 custom tagline preserved");
    assert(g1?.avatar === "/api/devices/avatar?id=ghost_1", "ghost_1 avatar URI built with ghost ID");

    // Check ghost_2 (no tagline)
    const g2 = res.presenters!.find(p => p.id === "ghost_2");
    assert(g2 !== undefined, "ghost_2 exists in presenters");
    assert(g2?.tagline === null, "ghost_2 tagline defaults to null when not in personas");

    // Check ghost_3 (string guest)
    const g3 = res.presenters!.find(p => p.id === "ghost_3");
    assert(g3 !== undefined, "ghost_3 (string guest) exists in presenters");
    assert(g3?.name === "ghost_3", "ghost_3 name falls back to id string");

    // Check ghost_5 from guestPersonaIds not in personas
    const g5 = res.presenters!.find(p => p.id === "ghost_5");
    assert(g5 !== undefined, "ghost_5 from guestPersonaIds exists in presenters");
    assert(g5?.name === "ghost_5", "ghost_5 name defaults to id");
    assert(g5?.tagline === null, "ghost_5 tagline is null");

    // Deduplication check: ghost_1 was in activeShow.guests AND matchedShow.guestPersonaIds
    const ghost1Count = res.presenters!.filter(p => p.id === "ghost_1").length;
    assert(ghost1Count === 1, "ghost_1 deduplicated across activeShow.guests and show.guestPersonaIds");
  }

  // 1.5 Circular and Cyclic References
  console.log("=== EMPIRICAL CHALLENGER: PART 3 — Circular & Cyclic References ===");
  {
    const cyclicHost: any = { id: "p_cyc", name: "Cyclic Host", tagline: "Cycle" };
    cyclicHost.self = cyclicHost;
    cyclicHost.nested = { deep: cyclicHost };

    const cyclicGuest: any = { id: "g_cyc", name: "Cyclic Guest", tagline: "Guest Cycle" };
    cyclicGuest.cycle = cyclicGuest;

    const cyclicShow: any = {
      name: "Cyclic Show",
      persona: cyclicHost,
      guests: [cyclicGuest],
      guestPersonaIds: ["g_cyc"],
    };
    cyclicShow.showRef = cyclicShow;

    const cyclicNp: any = {
      activeShow: cyclicShow,
    };
    cyclicNp.npRef = cyclicNp;

    const cyclicSched: any = {
      shows: [cyclicShow],
      personas: [cyclicHost, cyclicGuest],
    };
    cyclicSched.schedRef = cyclicSched;

    try {
      const res = svc.buildByline(cyclicNp, { streamIdle: false }, cyclicSched);
      assert(res.presenter === "Cyclic Host", "buildByline extracts presenter name from cyclic structure");
      assert(res.tagline === "Cycle", "buildByline extracts tagline from cyclic structure");
      assert(res.presenters!.length === 2, "buildByline resolved exactly 2 presenters with cyclic objects");
      assert(res.presenters![0].id === "p_cyc", "Host id matches");
      assert(res.presenters![1].id === "g_cyc", "Guest id matches");
    } catch (e: any) {
      assert(false, "buildByline threw unhandled exception on cyclic structures", e?.message);
    }
  }

  // 1.6 Presenters Array Schema Validation (Strictly { id, name, role, tagline, avatar } and NO userId)
  console.log("=== EMPIRICAL CHALLENGER: PART 4 — Strict Presenter Schema & No userId ===");
  {
    const np = {
      activeShow: {
        name: "Schema Test Show",
        persona: { id: "p_schema", name: "Schema Host", tagline: "Host Bio", userId: "LEAKED_USER_ID_1" },
        guests: [
          { id: "g_schema_1", name: "Guest 1", role: "Co-Host", tagline: "G1 Bio", userId: "LEAKED_USER_ID_2" },
          { id: "g_schema_2", name: "Guest 2", userId: "LEAKED_USER_ID_3" },
        ],
        guestPersonaIds: ["g_schema_3"],
      },
    };
    const sched = {
      shows: [{ id: "s1", name: "Schema Test Show", guestPersonaIds: ["g_schema_3"] }],
      personas: [
        { id: "p_schema", name: "Schema Host", tagline: "Host Bio", userId: "LEAKED_4" },
        { id: "g_schema_3", name: "Guest 3", tagline: "G3 Bio", role: "Special Guest", userId: "LEAKED_5" },
      ],
    };

    const res = svc.buildByline(np, { streamIdle: false }, sched);
    assert(res.presenters!.length === 4, "4 presenters resolved");

    const allowedKeys = new Set(["id", "name", "role", "tagline", "avatar"]);

    for (let i = 0; i < res.presenters!.length; i++) {
      const p = res.presenters![i];
      const keys = Object.keys(p);
      
      // Confirm no userId property
      assert(!("userId" in p), `presenter[${i}] (${p.name}) does NOT have userId property`);
      assert((p as any).userId === undefined, `presenter[${i}].userId is undefined`);

      // Confirm strictly allowed keys
      const unexpectedKeys = keys.filter(k => !allowedKeys.has(k));
      assert(unexpectedKeys.length === 0, `presenter[${i}] has strictly allowed keys`, `got unexpected: ${unexpectedKeys.join(", ")}`);

      // Confirm required properties and types
      assert(typeof p.id === "string", `presenter[${i}].id is string`);
      assert(typeof p.name === "string" && p.name.length > 0, `presenter[${i}].name is non-empty string`);
      assert(typeof p.role === "string" && p.role.length > 0, `presenter[${i}].role is non-empty string`);
      assert(p.tagline === null || typeof p.tagline === "string", `presenter[${i}].tagline is null or string`);
      assert(p.avatar === null || typeof p.avatar === "string", `presenter[${i}].avatar is null or string`);
    }
  }

  // 1.7 Scale Test: 50,000 Personas in buildByline (<100ms)
  console.log("=== EMPIRICAL CHALLENGER: PART 5 — Scale Test: 50,000 Personas (<100ms) ===");
  {
    console.log("  Generating 50,000 personas...");
    const personasCount = 50_000;
    const hugePersonas = new Array(personasCount);
    for (let i = 0; i < personasCount; i++) {
      hugePersonas[i] = {
        id: `p_scale_${i}`,
        name: `Persona Name ${i}`,
        tagline: i % 2 === 0 ? `Bio for ${i}` : `   `,
      };
    }

    const np = {
      activeShow: {
        name: "Scale Show",
        persona: { id: `p_scale_${personasCount - 1}`, name: `Persona Name ${personasCount - 1}` },
        guestPersonaIds: [`p_scale_0`, `p_scale_${Math.floor(personasCount / 2)}`],
      },
    };

    // Run 5 warm-up and measurement iterations
    const times: number[] = [];
    let lastRes: any = null;

    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      lastRes = svc.buildByline(np, { streamIdle: false }, { personas: hugePersonas });
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    console.log(`  50,000 personas buildByline times: min=${minTime.toFixed(2)}ms, max=${maxTime.toFixed(2)}ms, avg=${avgTime.toFixed(2)}ms`);

    assert(lastRes.presenter === `Persona Name ${personasCount - 1}`, "Presenter correctly resolved from 50k personas");
    assert(lastRes.presenters.length === 3, "Host and 2 guests resolved from 50k personas");
    assert(maxTime < 100, `Scale test max execution time ${maxTime.toFixed(2)}ms is < 100ms`);
  }

  // 2.0 Adversarial Testing on buildDeviceSchedule()
  console.log("=== EMPIRICAL CHALLENGER: PART 6 — buildDeviceSchedule() Edge Cases ===");
  {
    // 2.1 Unregistered guestPersonaIds in schedule shows
    const gridAllAdv: Record<string, string[]> = {};
    for (let d = 0; d < 7; d++) {
      gridAllAdv[String(d)] = Array(24).fill("s_adv");
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      timezone: "Australia/Melbourne",
      shows: [
        {
          id: "s_adv",
          name: "Adv Show",
          personaId: "p_real",
          guestPersonaIds: ["unregistered_g1", "unregistered_g2", "p_guest_real"],
        },
      ],
      personas: [
        { id: "p_real", name: "Real Host", tagline: "Real Host Tag" },
        { id: "p_guest_real", name: "Real Guest", tagline: "Real Guest Tag", role: "Co-Host" },
      ],
      schedule: gridAllAdv,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const slot = sched.slots.find(s => s.show.id === "s_adv");
    assert(slot !== undefined, "Slot for s_adv found");
    assert(slot?.show.presenters !== undefined, "slot.show.presenters exists");
    
    // In buildDeviceSchedule, unregistered guests in guestPersonaIds are dropped cleanly
    // because personaById.get(gid) is undefined.
    assert(slot?.show.presenters?.length === 2, "slot.show.presenters has host + real guest (unregistered dropped cleanly)");
    assert(slot?.show.guests?.length === 1, "slot.show.guests has real guest only");
    assert(slot?.show.guests?.[0].name === "Real Guest", "real guest name matches");
    assert(slot?.show.guests?.[0].avatar === "/api/devices/avatar?id=p_guest_real", "real guest avatar populated");

    // Check strict presenter shape in schedule slot
    for (const p of slot!.show.presenters!) {
      assert(!("userId" in p), `slot presenter ${p.name} has no userId`);
      const keys = Object.keys(p);
      const allowedKeys = new Set(["id", "name", "role", "tagline", "avatar"]);
      const unexpected = keys.filter(k => !allowedKeys.has(k));
      assert(unexpected.length === 0, `slot presenter has strictly allowed keys`, `unexpected: ${unexpected.join(",")}`);
    }

    // 2.2 Whitespace and non-string taglines in schedule
    globalThis.fetch = async () => new Response(JSON.stringify({
      timezone: "UTC",
      shows: [{ id: "s_tags", name: "Tags Show", personaId: "p_tags", guestPersonaIds: ["g_tags"] }],
      personas: [
        { id: "p_tags", name: "Host Tags", tagline: "   \t\n  " },
        { id: "g_tags", name: "Guest Tags", tagline: 123456 },
      ],
      schedule: { "0": ["s_tags"], "1": [], "2": [], "3": [], "4": [], "5": [], "6": [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const schedTags = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const slotTags = schedTags.slots.find(s => s.show.id === "s_tags");
    assert(slotTags?.show.tagline === null, "Host whitespace tagline normalized to null in slot");
    assert(slotTags?.show.presenters?.[0].tagline === null, "Host whitespace tagline normalized to null in presenters[0]");
    assert(slotTags?.show.presenters?.[1].tagline === null, "Guest numeric tagline normalized to null in presenters[1]");
    assert(slotTags?.show.guests?.[0].tagline === null, "Guest numeric tagline normalized to null in guests[0]");

    // 2.3 Auto DJ slot has empty presenters array
    const autoDjSlot = schedTags.slots.find(s => s.show.id === null);
    if (autoDjSlot) {
      assert(Array.isArray(autoDjSlot.show.presenters) && autoDjSlot.show.presenters.length === 0, "Auto DJ slot has empty presenters array");
    }
  }

  // 3.0 Source Code Verification Invariants
  console.log("=== EMPIRICAL CHALLENGER: PART 7 — Source Code Invariants ===");
  {
    const deviceServiceContent = fs.readFileSync(path.join(REPO, "lib/device-service.ts"), "utf8");
    const deviceTypesContent = fs.readFileSync(path.join(REPO, "lib/device-types.ts"), "utf8");

    // Check no userId in device-service.ts
    // Use regex word boundary check as in check-device-isolation.mts
    const hasUserIdInService = /\buserId\b/.test(deviceServiceContent);
    assert(!hasUserIdInService, "lib/device-service.ts contains NO reference to userId");

    // Check no non-localhost absolute URLs in device-service.ts
    const hasExternalUrls = /https?:\/\/(?!localhost)/.test(deviceServiceContent);
    assert(!hasExternalUrls, "lib/device-service.ts contains NO non-localhost absolute URLs");

    // Check DevicePresenter interface declaration
    const hasDevicePresenterExport = /export\s+interface\s+DevicePresenter\s*\{/.test(deviceTypesContent);
    assert(hasDevicePresenterExport, "lib/device-types.ts exports DevicePresenter interface");

    // Check DevicePresenter fields
    assert(/id:\s*string;/.test(deviceTypesContent), "DevicePresenter defines id: string");
    assert(/name:\s*string;/.test(deviceTypesContent), "DevicePresenter defines name: string");
    assert(/role:\s*string;/.test(deviceTypesContent), "DevicePresenter defines role: string");
    assert(/tagline\?:/.test(deviceTypesContent), "DevicePresenter defines tagline?");
    assert(/avatar\?:/.test(deviceTypesContent), "DevicePresenter defines avatar?");
    assert(!/userId/.test(deviceTypesContent.split("export interface DevicePresenter")[1].split("}")[0]), "DevicePresenter does NOT include userId");
  }

} catch (err: any) {
  assert(false, "Challenger suite encountered fatal error", String(err?.stack || err));
} finally {
  globalThis.fetch = origFetch;
  if (origSubwaveApiUrl !== undefined) {
    process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
  } else {
    delete process.env.SUBWAVE_API_URL;
  }
}

console.log("\n=======================================================");
console.log(`EMPIRICAL CHALLENGER VERIFICATION SUMMARY:`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=======================================================\n");

if (failed > 0) process.exit(1);
