// Empirical Verification & Fuzzing Harness for Milestone 1 Backend
// Challenger: challenger_m1_backend_2
//
// Tests:
// 1. Backward compatibility & baseline parity for single-host shows
//    (byline.presenter, byline.avatar, byline.tagline, byline.onAirForSec, byline.endsInSec, byline.live, slot.show.host)
// 2. Multi-host fuzzing over variations:
//    - 0 guests
//    - 1 guest
//    - 5 guests
//    - Duplicate guests (ID collisions, Name collisions case-insensitive, Host-as-guest collisions)
//    - Null, undefined, empty, and malformed guest names and structures
// 3. Scale, stress, and extreme input resilience
//
// Run: TEST_REPO_ROOT=$PWD node --import ./scripts/test-register.mjs scripts/challenge-m1-backend-2.mts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const SCHEMA = path.join(REPO, "prisma", ".gen-challenger-m1-b2.prisma");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-challenger-b2-"));
const dbFile = path.join(tmp, "challenge.db");
const cleanup = () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SCHEMA, { force: true });
};

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";
let origFetch = globalThis.fetch;
let origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
process.env.SUBWAVE_API_URL = "http://localhost:7700";

try {
  execFileSync("node", ["scripts/gen-schema.mjs", "sqlite", SCHEMA], { cwd: REPO, stdio: "pipe" });
  execFileSync("npx", ["prisma", "db", "push", "--schema", SCHEMA], {
    cwd: REPO, stdio: "pipe", env: { ...process.env },
  });

  const svc = await import("../lib/device-service.ts");
  const { computeShowRunway } = await import("../lib/show-runway.ts");

  console.log("\n=======================================================");
  console.log("SECTION 1: Single-Host Baseline Parity & Backward Compatibility");
  console.log("=======================================================");

  // Baseline implementation of pre-M1 buildByline for single-host
  function baselineBuildByline(nowPlaying: any, state: any, schedule: any) {
    const show = typeof nowPlaying?.activeShow?.name === "string" ? nowPlaying.activeShow.name : null;
    const presenter =
      typeof nowPlaying?.activeShow?.persona?.name === "string"
        ? nowPlaying.activeShow.persona.name
        : typeof nowPlaying?.dj?.name === "string"
          ? nowPlaying.dj.name
          : null;

    const presenterPersona =
      (nowPlaying?.activeShow?.persona && typeof nowPlaying.activeShow.persona === "object"
        ? nowPlaying.activeShow.persona
        : null) ||
      (nowPlaying?.dj && typeof nowPlaying.dj === "object" ? nowPlaying.dj : null) ||
      (presenter && Array.isArray(schedule?.personas)
        ? schedule.personas.find((p: any) => p && typeof p === "object" && p.name === presenter)
        : null);

    let presenterId = typeof presenterPersona?.id === "string" ? presenterPersona.id : null;
    if (!presenterId && presenter && Array.isArray(schedule?.personas)) {
      const match = schedule.personas.find((p: any) => p && typeof p === "object" && p.name === presenter);
      if (typeof match?.id === "string") presenterId = match.id;
    }
    const avatar = presenterId ? `/api/devices/avatar?id=${encodeURIComponent(presenterId)}` : null;
    const live = Boolean(nowPlaying) && !state?.streamIdle;

    let onAirForSec: number | null = null;
    const startedAt = state?.session?.startedAt;
    if (typeof startedAt === "string") {
      const t = Date.parse(startedAt);
      if (Number.isFinite(t)) onAirForSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    }

    let endsInSec: number | null = null;
    if (schedule?.timezone) {
      try {
        const runway = computeShowRunway({
          grid: schedule.schedule,
          shows: schedule.shows,
          personas: schedule.personas,
          timezone: schedule.timezone,
          override: schedule.override,
          now: Date.now(),
        });
        if (runway?.endMs) {
          endsInSec = Math.max(0, Math.round((runway.endMs - Date.now()) / 1000));
        }
      } catch {}
    }

    // Tagline baseline
    const matchedPersona = presenter && Array.isArray(schedule?.personas)
      ? schedule.personas.find((p: any) => p && typeof p === "object" && (p.id === presenterId || p.name === presenter))
      : null;
    const rawTagline = presenterPersona?.tagline ?? matchedPersona?.tagline;
    const tagline = typeof rawTagline === "string" && rawTagline.trim().length > 0 ? rawTagline.trim() : null;

    return { presenter, show, avatar, tagline, onAirForSec, endsInSec, live };
  }

  // 1.1 Systematic Single-Host Scenarios
  const singleHostScenarios = [
    {
      name: "Standard activeShow with full persona",
      np: {
        activeShow: {
          name: "Morning Groove",
          persona: { id: "p_maya", name: "Maya", tagline: "Sunrise beats", avatar: "/custom/avatar.png" },
        },
      },
      st: { streamIdle: false, session: { startedAt: new Date(Date.now() - 3600_000).toISOString() } },
      sc: {
        timezone: "UTC",
        schedule: { "0": ["s1"] },
        shows: [{ id: "s1", name: "Morning Groove", personaId: "p_maya" }],
        personas: [{ id: "p_maya", name: "Maya", tagline: "Sunrise beats" }],
      },
    },
    {
      name: "DJ format single host with tagline",
      np: {
        dj: { id: "dj_colin", name: "Colin", tagline: "Midnight bass" },
      },
      st: { streamIdle: false, session: { startedAt: new Date(Date.now() - 1800_000).toISOString() } },
      sc: null,
    },
    {
      name: "Single host resolved via schedule persona twin by name",
      np: {
        activeShow: { name: "Afternoon Flow", persona: { name: "Taylor" } },
      },
      st: { streamIdle: false },
      sc: {
        timezone: "UTC",
        personas: [{ id: "p_taylor", name: "Taylor", tagline: "Afternoon chill" }],
      },
    },
    {
      name: "Single host with no tagline (null)",
      np: {
        activeShow: { name: "Lunch Beats", persona: { id: "p_alex", name: "Alex" } },
      },
      st: { streamIdle: false },
      sc: {
        personas: [{ id: "p_alex", name: "Alex" }],
      },
    },
    {
      name: "Single host with whitespace-only tagline",
      np: {
        activeShow: { name: "Quiet Space", persona: { id: "p_quiet", name: "Quiet", tagline: "   \t \n  " } },
      },
      st: { streamIdle: false },
      sc: null,
    },
    {
      name: "Completely idle station (no stream, no nowPlaying)",
      np: null,
      st: { streamIdle: true },
      sc: null,
    },
    {
      name: "Stream idle true with nowPlaying present",
      np: { activeShow: { name: "Ghost Show", persona: { id: "p_ghost", name: "Ghost" } } },
      st: { streamIdle: true },
      sc: null,
    },
    {
      name: "Empty activeShow object",
      np: { activeShow: {} },
      st: { streamIdle: false },
      sc: null,
    },
  ];

  for (const tc of singleHostScenarios) {
    const actual = svc.buildByline(tc.np, tc.st, tc.sc);
    const expected = baselineBuildByline(tc.np, tc.st, tc.sc);

    ok(actual.presenter === expected.presenter, `${tc.name}: byline.presenter matches baseline`, `actual: ${actual.presenter}, expected: ${expected.presenter}`);
    ok(actual.show === expected.show, `${tc.name}: byline.show matches baseline`, `actual: ${actual.show}, expected: ${expected.show}`);
    ok(actual.avatar === expected.avatar, `${tc.name}: byline.avatar matches baseline`, `actual: ${actual.avatar}, expected: ${expected.avatar}`);
    ok(actual.tagline === expected.tagline, `${tc.name}: byline.tagline matches baseline`, `actual: ${actual.tagline}, expected: ${expected.tagline}`);
    ok(actual.live === expected.live, `${tc.name}: byline.live matches baseline`, `actual: ${actual.live}, expected: ${expected.live}`);
    ok(actual.onAirForSec === expected.onAirForSec, `${tc.name}: byline.onAirForSec matches baseline`);
    ok(actual.endsInSec === expected.endsInSec, `${tc.name}: byline.endsInSec matches baseline`);

    // Verify presenters array structure for single-host
    if (actual.live && actual.presenter) {
      ok(Array.isArray(actual.presenters), `${tc.name}: presenters is array`);
      ok(actual.presenters?.length === 1, `${tc.name}: presenters array has exactly 1 entry for single host`);
      const p0 = actual.presenters?.[0];
      ok(p0?.role === "Host", `${tc.name}: single presenter has role Host`);
      ok(p0?.name === actual.presenter, `${tc.name}: single presenter name matches byline.presenter`);
      ok(p0?.avatar === actual.avatar, `${tc.name}: single presenter avatar matches byline.avatar`);
      ok(p0?.tagline === actual.tagline, `${tc.name}: single presenter tagline matches byline.tagline`);
    } else {
      ok(Array.isArray(actual.presenters) && actual.presenters?.length === 0, `${tc.name}: idle/no-presenter has presenters: []`);
    }
  }

  // 1.2 Baseline parity in buildDeviceSchedule for single-host and Auto DJ slots
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/schedule")) {
        return new Response(JSON.stringify({
          timezone: "UTC",
          shows: [
            { id: "s_solo", name: "Solo Show", personaId: "p_solo" },
            { id: "s_notag", name: "Solo No Tag", personaId: "p_notag" },
          ],
          personas: [
            { id: "p_solo", name: "Solo Host", tagline: "Solo vibes" },
            { id: "p_notag", name: "No Tag Host" },
          ],
          schedule: {
            "0": ["s_solo", null, "s_notag"],
            "1": [], "2": [], "3": [], "4": [], "5": [], "6": [],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url);
    };

    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const soloSlot = sched.slots.find((s) => s.show.id === "s_solo");
    ok(soloSlot !== undefined, "soloSlot found");
    ok(soloSlot?.show.host === "Solo Host", "soloSlot.show.host is Solo Host (legacy field preserved)");
    ok(soloSlot?.show.hostId === "p_solo", "soloSlot.show.hostId is p_solo (legacy field preserved)");
    ok(soloSlot?.show.avatar === "/api/devices/avatar?id=p_solo", "soloSlot.show.avatar preserved");
    ok(soloSlot?.show.tagline === "Solo vibes", "soloSlot.show.tagline populated");
    ok(Array.isArray(soloSlot?.show.guests) && soloSlot?.show.guests.length === 0, "soloSlot.show.guests is empty array");
    ok(Array.isArray(soloSlot?.show.presenters) && soloSlot?.show.presenters.length === 1, "soloSlot.show.presenters has 1 entry");
    ok(soloSlot?.show.presenters?.[0]?.role === "Host" && soloSlot?.show.presenters?.[0]?.name === "Solo Host", "soloSlot presenter 0 is Host Solo Host");

    const autoDjSlot = sched.slots.find((s) => s.show.name === "Auto DJ");
    ok(autoDjSlot !== undefined, "autoDjSlot found");
    ok(autoDjSlot?.show.id === null, "autoDjSlot.show.id is null");
    ok(autoDjSlot?.show.host === undefined, "autoDjSlot.show.host is undefined");
    ok(autoDjSlot?.show.avatar === undefined, "autoDjSlot.show.avatar is undefined");
    ok(autoDjSlot?.show.tagline === undefined, "autoDjSlot.show.tagline is undefined");
    ok(Array.isArray(autoDjSlot?.show.presenters) && autoDjSlot?.show.presenters.length === 0, "autoDjSlot.show.presenters is empty array");
  }

  console.log("\n=======================================================");
  console.log("SECTION 2: Multi-Host Fuzzing & Combinatorial Stress");
  console.log("=======================================================");

  // 2.1 0 Guests variation
  {
    const np0 = {
      activeShow: {
        name: "Zero Guest Show",
        persona: { id: "p_host", name: "Host Persona", tagline: "Tag" },
        guests: [],
        guestPersonaIds: [],
      },
    };
    const res0 = svc.buildByline(np0, { streamIdle: false }, null);
    ok(res0.presenters?.length === 1, "0 guests: byline.presenters has exactly 1 entry (host)");
    ok(res0.presenters?.[0]?.role === "Host", "0 guests: sole presenter is Host");
    ok(res0.presenter === "Host Persona", "0 guests: legacy byline.presenter is preserved");
  }

  // 2.2 1 Guest variation (various shapes)
  {
    // A. Object with id, name, role, tagline
    const np1A = {
      activeShow: {
        name: "Single Guest Show",
        persona: { id: "p_host", name: "Host Persona" },
        guests: [{ id: "p_g1", name: "Guest One", role: "Co-Host", tagline: "Special Co-Host" }],
      },
    };
    const res1A = svc.buildByline(np1A, { streamIdle: false }, null);
    ok(res1A.presenters?.length === 2, "1 guest (object): byline.presenters has 2 entries");
    ok(res1A.presenters?.[0]?.role === "Host" && res1A.presenters?.[0]?.name === "Host Persona", "presenter 0 is Host");
    ok(res1A.presenters?.[1]?.role === "Co-Host" && res1A.presenters?.[1]?.name === "Guest One", "presenter 1 is Co-Host Guest One");
    ok(res1A.presenters?.[1]?.avatar === "/api/devices/avatar?id=p_g1", "guest avatar proxy URL formatted");
    ok(res1A.presenters?.[1]?.tagline === "Special Co-Host", "guest tagline formatted");

    // B. String guest ID resolved via schedule.personas
    const np1B = {
      activeShow: {
        id: "show_b",
        name: "Show B",
        persona: { id: "p_host", name: "Host B" },
        guestPersonaIds: ["p_guest_sched"],
      },
    };
    const sched1B = {
      shows: [{ id: "show_b", guestPersonaIds: ["p_guest_sched"] }],
      personas: [{ id: "p_guest_sched", name: "Resolved Guest", tagline: "From Schedule", role: "Analyst" }],
    };
    const res1B = svc.buildByline(np1B, { streamIdle: false }, sched1B);
    ok(res1B.presenters?.length === 2, "1 guest (sched persona): byline.presenters has 2 entries");
    ok(res1B.presenters?.[1]?.name === "Resolved Guest", "guest name resolved from schedule persona");
    ok(res1B.presenters?.[1]?.role === "Analyst", "guest role resolved from schedule persona");
    ok(res1B.presenters?.[1]?.tagline === "From Schedule", "guest tagline resolved from schedule persona");

    // C. Guest as bare string in activeShow.guests
    const np1C = {
      activeShow: {
        name: "Show C",
        persona: { id: "p_host", name: "Host C" },
        guests: ["p_guest_str"],
      },
    };
    const sched1C = {
      personas: [{ id: "p_guest_str", name: "String Persona", tagline: "Resolved String" }],
    };
    const res1C = svc.buildByline(np1C, { streamIdle: false }, sched1C);
    ok(res1C.presenters?.length === 2, "1 guest (bare string id): resolved cleanly");
    ok(res1C.presenters?.[1]?.name === "String Persona", "bare string resolved persona name");
  }

  // 2.3 5 Guests variation
  {
    const guests5 = [
      { id: "g1", name: "Guest One", role: "Co-Host", tagline: "Co-Host 1" },
      { id: "g2", name: "Guest Two", role: "Guest", tagline: "Guest 2" },
      { id: "g3", name: "Guest Three", role: "Specialist", tagline: "Tech Expert" },
      { id: "g4", name: "Guest Four", role: "Guest", tagline: "" },
      { id: "g5", name: "Guest Five", role: "Guest", tagline: "Final Guest" },
    ];
    const np5 = {
      activeShow: {
        name: "Panel of Five",
        persona: { id: "p_host", name: "Main Host", tagline: "Host Tag" },
        guests: guests5,
      },
    };
    const res5 = svc.buildByline(np5, { streamIdle: false }, null);
    ok(res5.presenters?.length === 6, "5 guests: byline.presenters has 6 entries (host + 5 guests)");
    ok(res5.presenters?.[0]?.role === "Host" && res5.presenters?.[0]?.name === "Main Host", "presenter 0 is Host");
    for (let i = 0; i < 5; i++) {
      const p = res5.presenters?.[i + 1];
      const expected = guests5[i];
      ok(p?.id === expected.id, `guest ${i + 1} id matches ${expected.id}`);
      ok(p?.name === expected.name, `guest ${i + 1} name matches ${expected.name}`);
      ok(p?.role === expected.role, `guest ${i + 1} role matches ${expected.role}`);
      const expectedTag = expected.tagline.trim() ? expected.tagline : null;
      ok(p?.tagline === expectedTag, `guest ${i + 1} tagline normalized correctly (${expectedTag})`);
      ok(p?.avatar === `/api/devices/avatar?id=${expected.id}`, `guest ${i + 1} avatar formatted correctly`);
    }
  }

  // 2.4 Duplicate Guests
  {
    // A. Duplicate Guest ID with same name
    const npDup1 = {
      activeShow: {
        name: "Duplicate ID Show",
        persona: { id: "p_host", name: "Host" },
        guests: [
          { id: "g_dup", name: "Duplicate Dave", role: "Guest" },
          { id: "g_dup", name: "Duplicate Dave", role: "Co-Host" }, // same ID
        ],
      },
    };
    const resDup1 = svc.buildByline(npDup1, { streamIdle: false }, null);
    ok(resDup1.presenters?.length === 2, "duplicate guest ID deduplicated to single entry in presenters");
    ok(resDup1.presenters?.[1]?.id === "g_dup" && resDup1.presenters?.[1]?.role === "Guest", "first occurrence preserved");

    // B. Duplicate Guest Name (case-insensitive) with different IDs
    const npDup2 = {
      activeShow: {
        name: "Duplicate Name Show",
        persona: { id: "p_host", name: "Host" },
        guests: [
          { id: "g_alpha", name: "Samantha Fox" },
          { id: "g_beta", name: "samantha fox" }, // same name lower case
        ],
      },
    };
    const resDup2 = svc.buildByline(npDup2, { streamIdle: false }, null);
    ok(resDup2.presenters?.length === 2, "duplicate guest name (case-insensitive) deduplicated to 1 guest");
    ok(resDup2.presenters?.[1]?.name === "Samantha Fox", "first occurrence name preserved");

    // C. Guest duplicating the Primary Host (ID match)
    const npDup3 = {
      activeShow: {
        name: "Host in Guest List Show",
        persona: { id: "p_host", name: "Main Host" },
        guests: [
          { id: "p_host", name: "Main Host", role: "Guest" }, // host in guests array
          { id: "p_real_guest", name: "Real Guest" },
        ],
      },
    };
    const resDup3 = svc.buildByline(npDup3, { streamIdle: false }, null);
    ok(resDup3.presenters?.length === 2, "guest duplicating host ID is deduplicated");
    ok(resDup3.presenters?.[0]?.role === "Host" && resDup3.presenters?.[0]?.name === "Main Host", "host remains primary host");
    ok(resDup3.presenters?.[1]?.id === "p_real_guest", "real guest is second presenter");

    // D. Guest duplicating the Primary Host (Name match, different ID or no ID)
    const npDup4 = {
      activeShow: {
        name: "Host Name in Guest List",
        persona: { id: "p_host", name: "Main Host" },
        guests: [
          { id: "g_fake", name: "main host" }, // same name, different id
        ],
      },
    };
    const resDup4 = svc.buildByline(npDup4, { streamIdle: false }, null);
    ok(resDup4.presenters?.length === 1, "guest duplicating host name (case-insensitive) is deduplicated");

    // E. Guest duplication across activeShow.guests AND guestPersonaIds
    const npDup5 = {
      activeShow: {
        id: "show_overlap",
        name: "Overlap Show",
        persona: { id: "p_host", name: "Host" },
        guests: [{ id: "g_overlap", name: "Overlap Guest" }],
        guestPersonaIds: ["g_overlap", "g_new"],
      },
    };
    const schedDup5 = {
      shows: [{ id: "show_overlap", guestPersonaIds: ["g_overlap", "g_sched_dup"] }],
      personas: [
        { id: "g_overlap", name: "Overlap Guest" },
        { id: "g_new", name: "New Guest" },
        { id: "g_sched_dup", name: "Sched Guest" },
      ],
    };
    const resDup5 = svc.buildByline(npDup5, { streamIdle: false }, schedDup5);
    const overlapOccurrences = resDup5.presenters?.filter((p) => p.id === "g_overlap");
    ok(overlapOccurrences?.length === 1, "overlap guest appearing in guests and guestPersonaIds deduplicated to 1");
  }

  // 2.5 Null, Undefined, Empty and Malformed Guest Variations
  {
    // A. Null / undefined guest array elements
    const npNulls = {
      activeShow: {
        name: "Null Guests Show",
        persona: { id: "p_host", name: "Host" },
        guests: [
          null,
          undefined,
          42,
          true,
          false,
          {},
          { id: null, name: null },
          { id: "", name: "" },
          { id: "g_valid", name: "Valid Guest" },
          null,
        ],
      },
    };
    const resNulls = svc.buildByline(npNulls, { streamIdle: false }, null);
    ok(resNulls.presenters?.length === 2, "null and primitive elements in guests array safely skipped");
    ok(resNulls.presenters?.[1]?.id === "g_valid" && resNulls.presenters?.[1]?.name === "Valid Guest", "valid guest preserved after nulls");

    // B. Guest object with id present but name null
    const npNullName = {
      activeShow: {
        name: "Null Name Show",
        persona: { id: "p_host", name: "Host" },
        guests: [{ id: "g_noname", name: null }],
      },
    };
    const resNullName = svc.buildByline(npNullName, { streamIdle: false }, null);
    ok(resNullName.presenters?.length === 2, "guest with null name and valid id resolved");
    ok(resNullName.presenters?.[1]?.name === "g_noname", "null name falls back to id");

    // C. Guest object with name present but id null/empty
    const npNullId = {
      activeShow: {
        name: "Null Id Show",
        persona: { id: "p_host", name: "Host" },
        guests: [{ id: null, name: "Name Only Guest" }],
      },
    };
    const resNullId = svc.buildByline(npNullId, { streamIdle: false }, null);
    ok(resNullId.presenters?.length === 2, "guest with null id and valid name resolved");
    ok(resNullId.presenters?.[1]?.name === "Name Only Guest", "name preserved");
    ok(resNullId.presenters?.[1]?.id === "", "null id normalized to empty string");
    ok(resNullId.presenters?.[1]?.avatar === null, "avatar is null when id is empty");

    // D. Guest with non-string role (defaults to Guest)
    const npBadRole = {
      activeShow: {
        name: "Bad Role Show",
        persona: { id: "p_host", name: "Host" },
        guests: [
          { id: "g_role1", name: "G1", role: 123 },
          { id: "g_role2", name: "G2", role: "   " },
          { id: "g_role3", name: "G3", role: null },
        ],
      },
    };
    const resBadRole = svc.buildByline(npBadRole, { streamIdle: false }, null);
    ok(resBadRole.presenters?.length === 4, "all 3 bad-role guests parsed");
    ok(resBadRole.presenters?.[1]?.role === "Guest", "number role defaulted to Guest");
    ok(resBadRole.presenters?.[2]?.role === "Guest", "whitespace role defaulted to Guest");
    ok(resBadRole.presenters?.[3]?.role === "Guest", "null role defaulted to Guest");

    // E. Massive guest list fuzzing (100 guests)
    const manyGuests = [];
    for (let i = 0; i < 100; i++) {
      manyGuests.push({
        id: `g_mass_${i}`,
        name: `Guest Mass ${i}`,
        tagline: `Tagline ${i}`,
        role: i % 2 === 0 ? "Co-Host" : "Guest",
      });
    }
    const npMass = {
      activeShow: {
        name: "Massive Guest Show",
        persona: { id: "p_host", name: "Host" },
        guests: manyGuests,
      },
    };
    const startMass = performance.now();
    const resMass = svc.buildByline(npMass, { streamIdle: false }, null);
    const elapsedMass = performance.now() - startMass;
    ok(resMass.presenters?.length === 101, "100 guests resolved with host (101 total)");
    ok(elapsedMass < 20, `resolving 100 guests took ${elapsedMass.toFixed(2)}ms (< 20ms)`);
  }

  // 2.6 Multi-Host in buildDeviceSchedule
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/schedule")) {
        return new Response(JSON.stringify({
          timezone: "UTC",
          shows: [
            { id: "s_multi", name: "Multi Show", personaId: "p_mhost", guestPersonaIds: ["p_mg1", "p_mg2", "p_mg3", "p_mg4", "p_mg5"] },
            { id: "s_messy", name: "Messy Guests Show", personaId: "p_mhost", guestPersonaIds: ["p_mg1", null, undefined, 999, "p_mg1", "nonexistent_persona"] },
          ],
          personas: [
            { id: "p_mhost", name: "Main Schedule Host", tagline: "Host Tag" },
            { id: "p_mg1", name: "Sched Guest 1", tagline: "Tag 1", role: "Co-Host" },
            { id: "p_mg2", name: "Sched Guest 2", tagline: "Tag 2" },
            { id: "p_mg3", name: "Sched Guest 3", tagline: "Tag 3" },
            { id: "p_mg4", name: "Sched Guest 4", tagline: "Tag 4" },
            { id: "p_mg5", name: "Sched Guest 5", tagline: "Tag 5" },
          ],
          schedule: {
            "0": ["s_multi", "s_messy"],
            "1": [], "2": [], "3": [], "4": [], "5": [], "6": [],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url);
    };

    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const multiSlot = sched.slots.find((s) => s.show.id === "s_multi");
    ok(multiSlot !== undefined, "s_multi slot found");
    ok(multiSlot?.show.host === "Main Schedule Host", "slot host legacy field matches");
    ok(multiSlot?.show.guests?.length === 5, "slot has 5 enriched guests");
    ok(multiSlot?.show.presenters?.length === 6, "slot has 6 presenters (host + 5 guests)");
    ok(multiSlot?.show.guests?.[0]?.role === "Co-Host", "first guest has role Co-Host");
    ok(multiSlot?.show.guests?.[0]?.avatar === "/api/devices/avatar?id=p_mg1", "first guest has enriched avatar");
    ok(multiSlot?.show.guests?.[0]?.tagline === "Tag 1", "first guest has enriched tagline");

    const messySlot = sched.slots.find((s) => s.show.id === "s_messy");
    ok(messySlot !== undefined, "s_messy slot found");
    // null, undefined, 999, and nonexistent_persona should be filtered out safely without throwing
    ok(Boolean(messySlot?.show.guests?.every((g) => Boolean(g && typeof g.id === "string" && g.id))), "all resolved messy guests have valid string id");
  }

  console.log("\n=======================================================");
  console.log("SECTION 3: Randomized Fuzzing Battery (1,000 Permutations)");
  console.log("=======================================================");

  const sampleNames = ["Maya", "Sam", "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Avery"];
  const sampleRoles = ["Host", "Co-Host", "Guest", "Analyst", "DJ", "Specialist", "", null, undefined, 42];
  const sampleTaglines = ["Groovy beats", "Live & loud", "Late vibes", "", "   ", "\n\t", null, undefined, 123, { text: "bad" }];

  let fuzzPassed = 0;
  for (let run = 0; run < 1000; run++) {
    const numGuests = run % 8; // 0 to 7 guests
    const guests = [];
    for (let g = 0; g < numGuests; g++) {
      const mode = (run + g) % 5;
      if (mode === 0) {
        // null or primitive
        guests.push(null);
      } else if (mode === 1) {
        // bare string
        guests.push(`p_guest_${g % 3}`);
      } else if (mode === 2) {
        // object with duplicate ID or name
        guests.push({
          id: `p_guest_${g % 3}`,
          name: sampleNames[(run + g) % sampleNames.length],
          role: sampleRoles[(run * g) % sampleRoles.length],
          tagline: sampleTaglines[(run + g) % sampleTaglines.length],
        });
      } else if (mode === 3) {
        // object with null name
        guests.push({
          id: `p_noname_${g}`,
          name: null,
          role: "Guest",
        });
      } else {
        // standard valid guest
        guests.push({
          id: `p_valid_${run}_${g}`,
          name: `${sampleNames[g % sampleNames.length]} ${run}`,
          role: "Guest",
          tagline: `Tagline ${run}`,
        });
      }
    }

    const np = {
      activeShow: {
        id: `show_${run}`,
        name: `Show ${run}`,
        persona: {
          id: `p_host_${run % 5}`,
          name: sampleNames[run % sampleNames.length],
          tagline: sampleTaglines[run % sampleTaglines.length],
        },
        guests,
        guestPersonaIds: [`p_extra_${run % 4}`],
      },
    };

    const sched = {
      shows: [{ id: `show_${run}`, guestPersonaIds: [`p_extra_${run % 4}`, `p_sched_${run % 2}`] }],
      personas: [
        { id: `p_host_${run % 5}`, name: sampleNames[run % sampleNames.length], tagline: "Host Sched Tag" },
        { id: `p_guest_0`, name: "Persona Zero", tagline: "Zero Tag" },
        { id: `p_guest_1`, name: "Persona One", tagline: "One Tag" },
        { id: `p_extra_${run % 4}`, name: `Extra ${(run % 4)}`, tagline: "Extra Tag" },
      ],
    };

    try {
      const out = svc.buildByline(np, { streamIdle: false }, sched);
      if (!Array.isArray(out.presenters)) throw new Error("out.presenters is not array");
      if (typeof out.live !== "boolean") throw new Error("out.live is not boolean");

      // Verify no duplicate IDs (non-empty)
      const ids = out.presenters.map((p) => p.id).filter(Boolean);
      const uniqueIds = new Set(ids);
      if (ids.length !== uniqueIds.size) {
        throw new Error(`Duplicate IDs found in presenters: ${JSON.stringify(ids)}`);
      }

      // Verify no duplicate names (case-insensitive)
      const names = out.presenters.map((p) => p.name.toLowerCase()).filter(Boolean);
      const uniqueNames = new Set(names);
      if (names.length !== uniqueNames.size) {
        throw new Error(`Duplicate names found in presenters: ${JSON.stringify(names)}`);
      }

      // Verify all presenters have string role, name, id
      for (const p of out.presenters) {
        if (typeof p.role !== "string" || !p.role) throw new Error(`Invalid presenter role: ${p.role}`);
        if (typeof p.name !== "string" || !p.name) throw new Error(`Invalid presenter name: ${p.name}`);
        if (typeof p.id !== "string") throw new Error(`Invalid presenter id: ${p.id}`);
        if (p.tagline !== null && typeof p.tagline !== "string") throw new Error(`Invalid presenter tagline: ${p.tagline}`);
      }

      fuzzPassed++;
    } catch (err: any) {
      ok(false, `fuzz iteration ${run} crashed`, err.message);
      break;
    }
  }

  ok(fuzzPassed === 1000, `1,000 randomized fuzzing iterations completed without a single invariant violation`, `passed: ${fuzzPassed}`);

  console.log("\n=======================================================");
  console.log("SECTION 4: Hostile Edge Cases & Extreme Payloads");
  console.log("=======================================================");

  // 4.1 URL Encoding and Special Characters in IDs
  {
    const specialGuests = [
      { id: "guest with spaces", name: "Space Guest" },
      { id: "guest/with/slashes", name: "Slash Guest" },
      { id: "guest?param=val&foo=bar", name: "Query Guest" },
      { id: "guest#fragment", name: "Fragment Guest" },
      { id: "guest_🎙️_emoji", name: "Emoji Guest" },
      { id: "ゲスト_日本語", name: "Unicode Guest" },
    ];

    const npSpecial = {
      activeShow: {
        name: "Special Chars Show",
        persona: { id: "host with spaces", name: "Space Host" },
        guests: specialGuests,
      },
    };

    const resSpecial = svc.buildByline(npSpecial, { streamIdle: false }, null);
    ok(resSpecial.presenters?.length === 7, "all 6 special character guests + host resolved");
    ok(resSpecial.presenters?.[0]?.avatar === "/api/devices/avatar?id=host%20with%20spaces", "host avatar URL-encoded");
    for (let i = 0; i < specialGuests.length; i++) {
      const g = specialGuests[i];
      const p = resSpecial.presenters?.[i + 1];
      ok(p?.avatar === `/api/devices/avatar?id=${encodeURIComponent(g.id)}`, `guest ${g.name} avatar URL correctly encoded: ${p?.avatar}`);
    }
  }

  // 4.2 Cyclical References in guests
  {
    const cyclicG1: any = { id: "g_cyc1", name: "Cyclic Guest 1", role: "Guest", tagline: "Tag 1" };
    const cyclicG2: any = { id: "g_cyc2", name: "Cyclic Guest 2", role: "Guest", tagline: "Tag 2" };
    cyclicG1.peer = cyclicG2;
    cyclicG2.peer = cyclicG1;
    cyclicG1.self = cyclicG1;

    const npCyclic = {
      activeShow: {
        name: "Cyclic Guest Show",
        persona: { id: "p_host", name: "Host" },
        guests: [cyclicG1, cyclicG2],
      },
    };

    try {
      const resCyclic = svc.buildByline(npCyclic, { streamIdle: false }, null);
      ok(resCyclic.presenters?.length === 3, "cyclical guest references handled without recursion or memory crash");
      ok(resCyclic.presenters?.[1]?.name === "Cyclic Guest 1", "cyclic guest 1 name parsed");
      ok(resCyclic.presenters?.[2]?.name === "Cyclic Guest 2", "cyclic guest 2 name parsed");
    } catch (e: any) {
      ok(false, "cyclical guest references crashed buildByline", e.message);
    }
  }

  // 4.3 Non-Array Types Passed as Guests
  {
    const badGuestShapes = [
      "just a string",
      12345,
      true,
      false,
      { not: "an array" },
      new Set(["p1", "p2"]),
      () => ["p1"],
    ];

    for (const badShape of badGuestShapes) {
      const npBad = {
        activeShow: {
          name: "Bad Shape Show",
          persona: { id: "p_host", name: "Host" },
          guests: badShape,
          guestPersonaIds: badShape,
        },
      };
      try {
        const resBad = svc.buildByline(npBad, { streamIdle: false }, null);
        ok(resBad.presenters?.length === 1, `non-array guests shape (${typeof badShape}) safely treated as empty`);
      } catch (e: any) {
        ok(false, `non-array guests shape (${typeof badShape}) threw exception`, e.message);
      }
    }
  }

  // 4.4 Scale Stress: 10,000 guests in buildByline
  {
    const hugeGuests = [];
    for (let i = 0; i < 10_000; i++) {
      hugeGuests.push({
        id: `g_scale_${i}`,
        name: `Guest Scale ${i}`,
        role: "Guest",
        tagline: `Tagline ${i}`,
      });
    }

    const npHuge = {
      activeShow: {
        name: "10k Guests Show",
        persona: { id: "p_host", name: "Host" },
        guests: hugeGuests,
      },
    };

    const startHuge = performance.now();
    const resHuge = svc.buildByline(npHuge, { streamIdle: false }, null);
    const elapsedHuge = performance.now() - startHuge;

    ok(resHuge.presenters?.length === 10_001, "10,000 guests successfully parsed into presenters array (10,001 total)");
    ok(elapsedHuge < 100, `processing 10,000 guests took ${elapsedHuge.toFixed(2)}ms (< 100ms)`);
  }

  // 4.5 buildDeviceSchedule with messy and duplicate guest IDs
  {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/schedule")) {
        return new Response(JSON.stringify({
          timezone: "UTC",
          shows: [
            {
              id: "show_messy_sched",
              name: "Messy Schedule Show",
              personaId: "p_sched_host",
              guestPersonaIds: [
                "g_sched_1",
                null,
                undefined,
                12345,
                {},
                "g_sched_2",
                "nonexistent_id",
                "g_sched_1", // duplicate
              ],
            },
          ],
          personas: [
            { id: "p_sched_host", name: "Sched Host", tagline: "Host Bio" },
            { id: "g_sched_1", name: "Sched Guest 1", tagline: "Bio 1", role: "Co-Host" },
            { id: "g_sched_2", name: "Sched Guest 2", tagline: "   \n\t   " }, // whitespace tagline
          ],
          schedule: {
            "0": ["show_messy_sched"],
            "1": [], "2": [], "3": [], "4": [], "5": [], "6": [],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return origFetch(url);
    };

    const sched = await svc.buildDeviceSchedule(Date.parse("2026-11-01T00:00:00Z"));
    const slot = sched.slots.find((s) => s.show.id === "show_messy_sched");
    ok(slot !== undefined, "messy schedule slot found");
    ok(slot?.show.host === "Sched Host", "slot host preserved");
    ok(slot?.show.tagline === "Host Bio", "slot tagline preserved");

    // All guests in slot.show.guests must be objects with id, name
    for (const g of slot?.show.guests || []) {
      ok(typeof g.id === "string" && g.id.length > 0, `guest id is valid string: ${g.id}`);
      ok(typeof g.name === "string" && g.name.length > 0, `guest name is valid string: ${g.name}`);
      ok(typeof g.role === "string" && g.role.length > 0, `guest role is valid string: ${g.role}`);
      ok(g.tagline === null || typeof g.tagline === "string", `guest tagline is null or string: ${g.tagline}`);
    }

    const g2 = slot?.show.guests?.find((g) => g.id === "g_sched_2");
    ok(g2?.tagline === null, "whitespace tagline normalized to null on schedule guest");

    // Presenters array on slot
    ok(slot?.show.presenters?.[0]?.role === "Host" && slot?.show.presenters?.[0]?.name === "Sched Host", "presenter 0 is Host");
  }

} catch (e: any) {
  ok(false, "challenge harness fatal error", String(e?.stack || e));
} finally {
  globalThis.fetch = origFetch;
  if (origSubwaveApiUrl !== undefined) {
    process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
  } else {
    delete process.env.SUBWAVE_API_URL;
  }
  cleanup();
}

console.log("\n=======================================================");
console.log(`CHALLENGE HARNESS SUMMARY:`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=======================================================\n");

if (failed > 0) process.exit(1);
