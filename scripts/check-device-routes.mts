// Behaviour the static audits cannot reach: things that RUN.
//
// check-device-isolation.mts proves a screen cannot resolve to a user by reading
// the source. It cannot prove that a settings merge behaves, that a signed URL
// expires when it says it does, or that a firmware upload is refused for the
// right reason. Those are the failures that do not crash — they return a
// plausible wrong answer, and the wall is the only place anybody finds out.
//
// THIS RUNS AGAINST A REAL DATABASE. Not a mock: the grace window in
// lib/device-auth.ts is a security boundary with a time dimension, and testing it
// against a hand-written stub proves nothing about whether the real column
// comparison, the real expiry predicate and the real null-clearing all agree.
//
// HERMETIC. A scratch SQLite database in the OS temp directory, removed on the way
// out. Nothing in the repo is touched, and the Prisma client is generated from
// the current schema so this works whichever provider the station is on — which
// matters, because the station moves between SQLite and Postgres and a check that
// only ran under one of them would stop running exactly when it was needed.
//
// Run: npm run check:device-routes
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = process.env.TEST_REPO_ROOT || process.cwd();
const SCHEMA = path.join(REPO, "prisma", ".gen-device-test.prisma");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subwave-devices-"));
const dbFile = path.join(tmp, "devices.db");
const cleanup = () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SCHEMA, { force: true });
};

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.DB_PROVIDER = "sqlite";

try {
  execFileSync("node", ["scripts/gen-schema.mjs", "sqlite", SCHEMA], { cwd: REPO, stdio: "pipe" });
  execFileSync("npx", ["prisma", "db", "push", "--schema", SCHEMA, "--skip-generate"], {
    cwd: REPO, stdio: "pipe", env: { ...process.env },
  });
  ok(fs.existsSync(dbFile), "a scratch database was built from the current schema");

  const prisma = (await import("../lib/prisma.ts")).default;
  const auth = await import("../lib/device-auth.ts");
  const svc = await import("../lib/device-service.ts");

  const base = {
    model: "jc8012p4a1", status: "claimed", buildStatus: "built",
    settingsRev: 1, orientation: "landscape", themeMode: "auto", brightness: 70,
    idleMode: "dim", idleMin: 15, idlePct: 20, skipEnabled: "1", rotateViews: "0",
    timezone: "Australia/Hobart", lat: -42.8821, lon: 147.3272,
  };
  const mkScreen = (over: Record<string, unknown> = {}) =>
    prisma.device.create({ data: { name: "Test", ...base, ...over } });

  // ---- hashing is not reversible by accident ----------------------------
  {
    const a = auth.hashToken("abc");
    const b = auth.hashToken("abc");
    ok(a === b, "the same token hashes the same way");
    ok(a !== auth.hashToken("abd"), "a different token hashes differently");
    ok(/^[0-9a-f]{64}$/.test(a), "the stored form is a sha256 hex digest, never the token");
  }

  // ---- claim: four different failures, four different meanings -----------
  // "Flash didn't complete", "someone removed this screen" and "the build is
  // stale" are three different problems for whoever is holding a wall panel, and
  // answering all three with 403 would leave them guessing.
  {
    const row = await mkScreen({ deviceId: "dev-1" });
    const claim = await auth.mintClaimToken(row);
    const fresh = await prisma.device.findUniqueOrThrow({ where: { id: row.id } });

    ok((await auth.consumeClaimToken("dev-1", claim.raw)).ok, "a live claim token is accepted");
    // Checking is not consuming. The burn happens when the long-lived token is
    // minted, and the window between the two is milliseconds — so the contract
    // is about what is left in the ROW afterwards, not about the second check.
    ok((await auth.consumeClaimToken("dev-1", claim.raw)).ok, "checking does not itself consume the code");

    const noSuch = await auth.consumeClaimToken("nobody", "x");
    ok(!noSuch.ok && noSuch.reason === "unknown", "a screen nobody registered is 'unknown'");

    const stale = await mkScreen({ deviceId: "dev-2" });
    const staleClaim = await auth.mintClaimToken(stale);
    await prisma.device.update({ where: { id: stale.id }, data: { claimExpires: new Date(Date.now() - 1000) } });
    const expired = await auth.consumeClaimToken("dev-2", staleClaim.raw);
    ok(!expired.ok && expired.reason === "expired", "an expired code is 'expired', not 'wrong'", expired.ok ? "" : expired.reason);

    // Minting a long-lived token must BURN the claim token in the same act.
    await auth.mintDeviceToken(fresh);
    const after = await prisma.device.findUniqueOrThrow({ where: { id: fresh.id } });
    ok(after.tokenHash !== null && after.tokenHash.length === 64, "the long-lived token is stored hashed");
    const spent = await auth.consumeClaimToken("dev-1", claim.raw);
    ok(!spent.ok && (spent as { reason: string }).reason === "used", "once claimed, the setup code is dead and cannot be replayed",
       spent.ok ? "REPLAYED" : (spent as { reason: string }).reason);
    ok(after.claimToken === null, "and its hash is gone from the row, which is what makes 'used' true");

    void row;
  }

  // ---- bind -> claim: the pair the bind route hands out must be claimable ----
  // The bind route once overwrote the hashed claim token with the raw one, so
  // every real screen bound fine and then 404'd at claim: it never got a bearer
  // token, never polled, never heartbeated. Run the real route, then claim.
  {
    const row = await mkScreen({ name: "Bindable", status: "building", buildStatus: "building" });
    await prisma.device.update({
      where: { id: row.id },
      data: { bindCode: "ZZ9-ZZ9", bindCodeExpires: new Date(Date.now() + 60_000) },
    });
    const out = await auth.bindDevice("zz9-zz9");
    ok(out.ok === true, "bind accepts a live code (case-insensitive)");
    if (out.ok) {
      const stored = await prisma.device.findUniqueOrThrow({ where: { id: row.id } });
      ok(stored.claimToken === auth.hashToken(out.claimToken), "the row stores the HASH of the claim token, never the raw value");
      ok(stored.bindCode === null, "the bind code is single-use and cleared");
      const claimed = await auth.consumeClaimToken(out.deviceId, out.claimToken);
      ok(claimed.ok === true, "the token returned by bind is accepted by claim", claimed.ok ? "" : claimed.reason);
    }
    const again = await auth.bindDevice("ZZ9-ZZ9");
    ok(again.ok === false && again.status === 404, "a spent bind code cannot be reused");
  }

  // ---- rotation: the grace window is the whole design ------------------
  {
    const row = await mkScreen({ deviceId: "dev-3" });
    const original = await auth.mintDeviceToken(row);
    const req = (token: string) => ({ headers: { get: () => `Bearer ${token}` } } as unknown as Request);

    ok((await auth.deviceAuth(req(original)))?.id === row.id, "the device authenticates with its live token");
    ok((await auth.deviceAuth(req(original)))?.viaRotation === false, "...and it is not flagged as a rotation");

    await auth.beginRotation(row);

    // The screen is mid-flight on the old credential. It must keep working, and
    // it must be told about it — this is the whole reason the window exists.
    const during = await auth.deviceAuth(req(original));
    ok(during?.id === row.id, "the old token still authenticates inside the grace window");
    ok(during?.viaRotation === true, "...and the request is flagged, so the response can carry the replacement");

    const replacement = await auth.completeRotation(during!.row);
    ok(typeof replacement === "string", "the replacement token is issued at the handoff");
    ok(replacement !== original, "the replacement is a different token");
    const afterRotate = await auth.deviceAuth(req(original));
    ok(afterRotate === null, "the old token is dead the instant the replacement is handed over");
    ok((await auth.deviceAuth(req(replacement!)))?.id === row.id, "the replacement works");
    // The handoff is single-use: a concurrent or replayed completion must not
    // mint a second live credential from the same grace window.
    ok((await auth.completeRotation(during!.row)) === null, "a second completion of the same handoff issues nothing");

    // A window that has expired must not keep working, or "reset credentials"
    // would be a button that does nothing.
    const expiring = await mkScreen({ deviceId: "dev-4" });
    const tok = await auth.mintDeviceToken(expiring);
    await auth.beginRotation(expiring);
    await prisma.device.update({
      where: { id: expiring.id },
      data: { prevTokenExpires: new Date(Date.now() - 1000) },
    });
    ok((await auth.deviceAuth(req(tok))) === null, "an expired grace window closes the old token");
  }

  // ---- a revoked device is refused even with a valid token -------------
  {
    const row = await mkScreen({ deviceId: "dev-5" });
    const tok = await auth.mintDeviceToken(row);
    await prisma.device.update({ where: { id: row.id }, data: { status: "revoked" } });
    ok((await auth.deviceAuth({ headers: { get: () => `Bearer ${tok}` } } as unknown as Request)) === null,
       "a revoked screen is refused even though its token is still valid — revocation is about the row, not the credential");
  }

  // ---- settings merge: revision only moves when something changed -----
  {
    const row = await mkScreen({ deviceId: "dev-6" });
    const before = await prisma.device.findUniqueOrThrow({ where: { id: row.id } });

    const noop = await svc.applyDeviceSettings(before, { brightness: before.brightness });
    ok(noop.changed === false, "applying the value that is already set changes nothing");
    ok(noop.settingsRev === before.settingsRev, "...and does NOT bump the revision");

    const real = await svc.applyDeviceSettings(before, { brightness: 40 });
    ok(real.changed === true && real.settings.brightness === 40, "a real change is applied");
    ok(real.settingsRev === before.settingsRev + 1, "...and bumps the revision exactly once");

    // Bumping unconditionally would make the device and the admin flap forever:
    // device applies, reports appliedRev, server nudges again, repeat.
    const after = await prisma.device.findUniqueOrThrow({ where: { id: row.id } });
    const again = await svc.applyDeviceSettings(after, { brightness: 40 });
    ok(again.settingsRev === after.settingsRev, "re-applying an already-applied value does not flap the revision");

    // Clamping, so a device cannot ask for a brightness of 4000 or -1.
    const high = await svc.applyDeviceSettings(after, { brightness: 4000 });
    ok(high.settings.brightness === 100, "brightness is clamped to 100");
    const low = await svc.applyDeviceSettings(after, { idleMin: -5 });
    ok(low.settings.idleMin === 1, "idle minutes is clamped to at least 1");

    // Nonsense is ignored rather than stored.
    const junk = await svc.applyDeviceSettings(after, { orientation: "sideways" as never, themeMode: "chartreuse" as never });
    ok(junk.changed === false, "an unrecognised enum value is ignored rather than written");
  }

  // ---- the theme window, with an injected clock ------------------------
  {
    // Melbourne-ish, and the solstice. resolveTheme takes `atMs` precisely so
    // this is testable at all.
    const night = svc.resolveTheme({ ...base, themeMode: "auto" }, Date.parse("2026-06-21T13:00:00Z"));
    ok(night.isNight === true, "23:00 in Hobart (UTC+10) is night");
    ok(night.brightness <= svc.NIGHT_BRIGHTNESS_CAP, "...and night brightness respects the cap");

    const day = svc.resolveTheme({ ...base, themeMode: "auto" }, Date.parse("2026-06-21T02:00:00Z"));
    ok(day.isNight === false, "12:00 in Hobart (UTC+10) is day");
    ok(day.brightness <= svc.DAY_BRIGHTNESS_CAP, "day brightness is capped BELOW night");

    // No coordinates: the screen must fall back to night, which is the SAFE
    // direction — a screen that dims too far is fixable from the app, and one
    // that blazes at 3am is not.
    const noCoords = svc.resolveTheme({ ...base, lat: null, lon: null, themeMode: "auto" }, Date.parse("2026-06-21T02:00:00Z"));
    ok(noCoords.isNight === true, "with no coordinates the screen assumes night, not day");

    // Pinning overrides the astronomy, which is the point of having the setting.
    ok(svc.resolveTheme({ ...base, themeMode: "day" }, Date.parse("2026-06-21T03:00:00Z")).mode === "day",
       "themeMode=day pins day even at 3am");
    ok(svc.resolveTheme({ ...base, themeMode: "night" }, Date.parse("2026-06-21T02:00:00Z")).mode === "night",
       "themeMode=night pins night even at midday");

    // A longitude that is merely a number, not a place, must not throw.
    const silly = svc.resolveTheme({ ...base, lat: 91, lon: 400, themeMode: "auto" }, Date.parse("2026-06-21T02:00:00Z"));
    ok(silly.isNight === true, "nonsense coordinates fall back to night rather than throwing");

    ok(svc.resolveTheme({ ...base, themeMode: "auto" }, Date.parse("2026-06-21T02:00:00Z")).sunriseMs > 0,
       "sunrise and sunset come back for the device to draw a daylight band");
  }

  // ---- and the device is still not a listener -------------------------
  {
    // The strongest statement available: after exercising every credential path,
    // nothing has appeared in the presence map.
    const { freshPresence } = await import("../lib/presence-live.ts");
    ok(freshPresence(Date.now()).length === 0, "no screen operation added anything to the presence map");
    const streams = await prisma.streamSession.count();
    ok(streams === 0, "and none opened a StreamSession — a screen is not a listener");
    void auth;
  }

  // ---- presenter tagline in buildByline() (Milestone 1 R1) -------------
  {
    // 1. Tagline on activeShow persona directly
    const npDirect = {
      activeShow: {
        name: "Evening Wind Down",
        persona: { id: "p_sam", name: "Sam", tagline: "Deep thoughts and late tunes" },
      },
    };
    const resDirect = svc.buildByline(npDirect, { streamIdle: false }, null);
    ok(resDirect.tagline === "Deep thoughts and late tunes", "buildByline returns tagline when present on activeShow.persona");
    ok(resDirect.presenter === "Sam", "byline presenter is Sam");

    // 2. Tagline resolved from schedule.personas twin by ID
    const npTwin = {
      activeShow: {
        name: "Morning Chorus",
        persona: { id: "p_maya", name: "Maya" }, // no tagline in nowPlaying
      },
    };
    const schedTwin = {
      personas: [
        { id: "p_maya", name: "Maya", tagline: "Sunrise sounds and coffee" },
      ],
    };
    const resTwin = svc.buildByline(npTwin, { streamIdle: false }, schedTwin);
    ok(resTwin.tagline === "Sunrise sounds and coffee", "buildByline resolves tagline from schedule persona twin by ID");

    // 3. Tagline resolved from schedule.personas twin by presenter name
    const npName = {
      activeShow: {
        name: "Friday Jam",
        persona: { name: "Owen" },
      },
    };
    const schedName = {
      personas: [
        { id: "p_owen", name: "Owen", tagline: "Upbeat grooves" },
      ],
    };
    const resName = svc.buildByline(npName, { streamIdle: false }, schedName);
    ok(resName.tagline === "Upbeat grooves", "buildByline resolves tagline from schedule persona twin by name");

    // 4. DJ format with tagline
    const npDj = {
      dj: { id: "dj_alex", name: "Alex", tagline: "Underground electronic" },
    };
    const resDj = svc.buildByline(npDj, { streamIdle: false }, null);
    ok(resDj.tagline === "Underground electronic", "buildByline resolves tagline for DJ format");

    // 5. Presenter exists but has NO tagline (null)
    const npNoTag = {
      activeShow: {
        name: "Guest Hour",
        persona: { id: "p_guest", name: "Guest" },
      },
    };
    const resNoTag = svc.buildByline(npNoTag, { streamIdle: false }, { personas: [{ id: "p_guest", name: "Guest" }] });
    ok(resNoTag.tagline === null, "buildByline returns null when persona has no tagline");

    // 6. Whitespace-only tagline is normalized to null
    const npBlank = {
      activeShow: {
        name: "Quiet Show",
        persona: { id: "p_blank", name: "Blank", tagline: "   " },
      },
    };
    const resBlank = svc.buildByline(npBlank, { streamIdle: false }, null);
    ok(resBlank.tagline === null, "buildByline normalizes whitespace-only tagline to null");

    // 7. Off-air / station idle
    const resIdle = svc.buildByline(null, { streamIdle: true }, null);
    ok(resIdle.tagline === null, "buildByline returns null tagline when station is idle");
    ok(resIdle.presenter === null && resIdle.live === false, "byline is completely idle");
    ok(Array.isArray(resIdle.presenters) && resIdle.presenters.length === 0, "byline.presenters is empty array when station is idle");

    // 8. Multi-host / co-hosts and guests in buildByline (Milestone 1 R2)
    const npMulti = {
      activeShow: {
        id: "show_duo",
        name: "Morning Duo",
        persona: { id: "p_maya", name: "Maya", tagline: "Sunrise beats" },
        guestPersonaIds: ["p_sam"],
      },
    };
    const schedMulti = {
      shows: [{ id: "show_duo", name: "Morning Duo", personaId: "p_maya", guestPersonaIds: ["p_sam"] }],
      personas: [
        { id: "p_maya", name: "Maya", tagline: "Sunrise beats" },
        { id: "p_sam", name: "Sam", tagline: "Late night reflections" },
      ],
    };
    const resMulti = svc.buildByline(npMulti, { streamIdle: false }, schedMulti);
    ok(Array.isArray(resMulti.presenters), "buildByline returns presenters array");
    const presenters = resMulti.presenters ?? [];
    ok(presenters.length === 2, "buildByline resolves 2 presenters (host + guest)");
    ok(presenters[0]?.role === "Host" && presenters[0]?.name === "Maya", "first presenter is Host Maya");
    ok(presenters[0]?.avatar === "/api/devices/avatar?id=p_maya", "host avatar URL resolved");
    ok(presenters[0]?.tagline === "Sunrise beats", "host tagline resolved");
    ok(presenters[1]?.role === "Guest" && presenters[1]?.name === "Sam", "second presenter is Guest Sam");
    ok(presenters[1]?.avatar === "/api/devices/avatar?id=p_sam", "guest avatar URL resolved");
    ok(presenters[1]?.tagline === "Late night reflections", "guest tagline resolved");
    ok(resMulti.presenter === "Maya", "backward compatibility: byline.presenter is Maya");
    ok(resMulti.tagline === "Sunrise beats", "backward compatibility: byline.tagline is Sunrise beats");

    // The now-playing feed and the schedule can disagree about a show's name,
    // and the feed does not always carry a show id. The host persona is the one
    // key both sides agree on, so a renamed show must still find its co-host.
    const npRenamed = {
      activeShow: {
        name: "Morning Duo (Live)",
        persona: { id: "p_maya", name: "Maya", tagline: "Sunrise beats" },
      },
    };
    const resRenamed = svc.buildByline(npRenamed, { streamIdle: false }, schedMulti);
    ok(
      (resRenamed.presenters ?? []).length === 2,
      "a show renamed in the live feed still resolves its co-host via the host persona id"
    );
  }

  // ---- presenter tagline in buildDeviceSchedule() (Milestone 1 R1) -----
  {
    const origFetch = globalThis.fetch;
    const origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
    process.env.SUBWAVE_API_URL = "http://localhost:7700";
    const sunday = Date.parse("2026-11-01T00:00:00Z"); // Sunday, day 0 in UTC
    try {
      globalThis.fetch = async (url) => {
        if (String(url).includes("/schedule")) {
          return new Response(JSON.stringify({
            timezone: "UTC",
            shows: [
              { id: "show_winddown", name: "Evening Wind Down", personaId: "p_sam" },
              { id: "show_notag", name: "No Tagline Show", personaId: "p_notag" },
              { id: "show_panel", name: "Community Panel", personaId: "p_sam", guestPersonaIds: ["p_notag"] },
              { id: "show_dedup", name: "Deduplication Panel", personaId: "p_sam", guestPersonaIds: ["p_sam", "p_notag", "p_notag"] },
            ],
            personas: [
              { id: "p_sam", name: "Sam", tagline: "Deep thoughts and late tunes" },
              { id: "p_notag", name: "No Tag" },
            ],
            schedule: {
              "0": ["show_winddown", "show_winddown", null, "show_notag", "show_panel", "show_dedup"],
              "1": [], "2": [], "3": [], "4": [], "5": [], "6": [],
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return origFetch(url);
      };

      const sched = await svc.buildDeviceSchedule(sunday);
      ok(sched.slots.length >= 3, "buildDeviceSchedule returned slots");

      // Slot 1: Show with host and tagline
      const slot1 = sched.slots.find((s) => s.show.id === "show_winddown");
      ok(slot1 !== undefined, "show_winddown slot found");
      ok(slot1?.show.host === "Sam", "slot 1 host is Sam");
      ok(slot1?.show.tagline === "Deep thoughts and late tunes", "slot 1 show.tagline is populated from host persona");

      // Slot 2: Auto DJ slot
      const autoDj = sched.slots.find((s) => s.show.name === "Auto DJ");
      ok(autoDj !== undefined, "Auto DJ slot found");
      ok(autoDj?.show.id === null, "Auto DJ show.id is null");
      ok(autoDj?.show.host === undefined, "Auto DJ has no host");
      ok(autoDj?.show.tagline === null || autoDj?.show.tagline === undefined, "Auto DJ show.tagline is null or omitted");

      // Slot 3: Show with host but no tagline
      const slot3 = sched.slots.find((s) => s.show.id === "show_notag");
      ok(slot3 !== undefined, "show_notag slot found");
      ok(slot3?.show.host === "No Tag", "slot 3 host is No Tag");
      ok(slot3?.show.tagline === null, "slot 3 show.tagline is null when host has no tagline");

      // Slot 4: Show with host and guest (presenters + enriched guests)
      const slotPanel = sched.slots.find((s) => s.show.id === "show_panel");
      ok(slotPanel !== undefined, "show_panel slot found");
      ok(slotPanel?.show.presenters?.length === 2, "show_panel has 2 presenters (host + guest)");
      ok(slotPanel?.show.presenters?.[0]?.role === "Host" && slotPanel?.show.presenters?.[0]?.name === "Sam", "slotPanel presenter 0 is Host Sam");
      ok(slotPanel?.show.presenters?.[1]?.role === "Guest" && slotPanel?.show.presenters?.[1]?.name === "No Tag", "slotPanel presenter 1 is Guest No Tag");
      ok(slotPanel?.show.guests?.length === 1, "show_panel has 1 guest");
      ok(slotPanel?.show.guests?.[0]?.id === "p_notag", "guest id is p_notag");
      ok(slotPanel?.show.guests?.[0]?.name === "No Tag", "guest name is No Tag");
      ok(slotPanel?.show.guests?.[0]?.avatar === "/api/devices/avatar?id=p_notag", "guest avatar is enriched");
      ok(slotPanel?.show.guests?.[0]?.tagline === null, "guest tagline is null");

      // Slot 5: Show with duplicate guestPersonaIds including the host ID (Milestone 1 Iteration 2 Deduplication)
      const slotDedup = sched.slots.find((s) => s.show.id === "show_dedup");
      ok(slotDedup !== undefined, "show_dedup slot found");

      // Verify slot.show.presenters deduplication
      const dedupPresenters = slotDedup?.show.presenters ?? [];
      ok(dedupPresenters.length === 2, "show_dedup resolves exactly 2 unique presenters (Host Sam + Guest No Tag)");
      ok(dedupPresenters[0]?.role === "Host" && dedupPresenters[0]?.name === "Sam" && dedupPresenters[0]?.id === "p_sam", "first presenter is Host Sam");
      ok(dedupPresenters[1]?.role === "Guest" && dedupPresenters[1]?.name === "No Tag" && dedupPresenters[1]?.id === "p_notag", "second presenter is Guest No Tag");

      const presenterIds = dedupPresenters.map((p) => p.id);
      ok(new Set(presenterIds).size === presenterIds.length, "slot.show.presenters contains only unique presenter IDs");
      ok(!dedupPresenters.some((p) => p.role === "Guest" && p.id === "p_sam"), "host ID is not duplicated as a guest in presenters");

      // Verify slot.show.guests deduplication
      const dedupGuests = slotDedup?.show.guests ?? [];
      ok(dedupGuests.length === 1, "show_dedup has exactly 1 unique guest (host ID and duplicate guest excluded)");
      ok(dedupGuests[0]?.id === "p_notag" && dedupGuests[0]?.name === "No Tag", "dedup guest is No Tag");
      const guestIds = dedupGuests.map((g) => g.id);
      ok(new Set(guestIds).size === guestIds.length, "slot.show.guests contains only unique guest IDs");
      ok(!dedupGuests.some((g) => g.id === "p_sam"), "slot.show.guests does not contain host persona ID");

      // Verify presenters on other slots
      ok(slot1?.show.presenters?.length === 1, "slot 1 show.presenters has 1 presenter (host)");
      ok(slot1?.show.presenters?.[0]?.role === "Host" && slot1?.show.presenters?.[0]?.name === "Sam", "slot 1 presenter is Host Sam");
      ok(Array.isArray(autoDj?.show.presenters) && autoDj?.show.presenters.length === 0, "Auto DJ show.presenters is empty array");
    } finally {
      globalThis.fetch = origFetch;
      if (origSubwaveApiUrl !== undefined) {
        process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
      } else {
        delete process.env.SUBWAVE_API_URL;
      }
    }
  }

  // ---- buildDeviceState resolves the byline bio from the feed schedule --
  {
    // now-playing strips persona taglines (the listener feed needs a name and a
    // face, not a biography), so /state must resolve them from /schedule. It
    // used to fetch /schedule a second time just for that, which is both a
    // wasted large fetch and a window where a failure leaves the wall saying
    // "No bio provided" for a presenter who has one.
    const row = await mkScreen({ name: "State screen" });
    const origFetch = globalThis.fetch;
    const origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
    process.env.SUBWAVE_API_URL = "http://localhost:7700";
    let scheduleFetches = 0;
    try {
      const schedule = {
        timezone: "UTC",
        shows: [{ id: "show_morning", name: "Morning Chorus", personaId: "p_maya" }],
        personas: [{ id: "p_maya", name: "Maya", tagline: "Sunrise sounds and coffee" }],
        schedule: Object.fromEntries(
          Array.from({ length: 7 }, (_, d) => [String(d), Array(24).fill("show_morning")]),
        ),
      };
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith("/schedule")) {
          scheduleFetches++;
          return new Response(JSON.stringify(schedule), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.endsWith("/now-playing")) {
          return new Response(JSON.stringify({
            activeShow: { id: "show_morning", name: "Morning Chorus", persona: { id: "p_maya", name: "Maya" } },
            nowPlaying: { title: "Track", artist: "Artist", subsonic_id: "abc", duration: 180 },
            listeners: { current: 0 },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.endsWith("/state")) {
          return new Response(JSON.stringify({ streamIdle: false, station: { name: "Test FM" } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      };

      const built = await svc.buildDeviceState(row);
      ok(built.byline.presenter === "Maya", "buildDeviceState byline names the on-air presenter");
      ok(built.byline.tagline === "Sunrise sounds and coffee", "buildDeviceState byline bio comes from the feed schedule");
      ok(built.byline.presenters?.[0]?.tagline === "Sunrise sounds and coffee",
        "buildDeviceState presenter entry carries the same bio the modal renders");
      ok(scheduleFetches === 1, "one /state build fetches /schedule once, not twice");
    } finally {
      globalThis.fetch = origFetch;
      if (origSubwaveApiUrl !== undefined) {
        process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
      } else {
        delete process.env.SUBWAVE_API_URL;
      }
    }
  }

  // ---- /api/devices/avatar sizing and clamping (Milestone 1 R1) --------
  {
    const sharp = (await import("sharp")).default;
    const { NextRequest } = await import("next/server.js");
    const avatarRoute = await import("../app/api/devices/avatar/route.ts");

    // End-to-end route execution against scratch DB device
    const screenRow = await mkScreen({ deviceId: "dev-avatar" });
    const screenToken = await auth.mintDeviceToken(screenRow);

    // Generate in-memory 300x300 fixture PNG
    const fixturePng = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 120, g: 150, b: 180 } },
    }).png().toBuffer();

    const origFetch = globalThis.fetch;
    const origSubwaveApiUrl = process.env.SUBWAVE_API_URL;
    process.env.SUBWAVE_API_URL = "http://localhost:7700";
    try {
      globalThis.fetch = async (url) => {
        if (String(url).includes("/persona-avatar/")) {
          return new Response(fixturePng, { status: 200, headers: { "Content-Type": "image/png" } });
        }
        return origFetch(url);
      };

      // 1. Default size (no size parameter -> 128x128)
      const reqDefault = new NextRequest("http://localhost/api/devices/avatar?id=p_sam", {
        headers: { Authorization: `Bearer ${screenToken}` },
      });
      const resDefault = await avatarRoute.GET(reqDefault);
      ok(resDefault.status === 200, "avatar route returns 200 for valid request");
      ok(resDefault.headers.get("Content-Type") === "image/png", "avatar route returns image/png");
      ok(resDefault.headers.get("Cache-Control") === "public, max-age=86400, immutable", "avatar carries immutable cache header");
      const metaDefault = await sharp(Buffer.from(await resDefault.arrayBuffer())).metadata();
      ok(metaDefault.width === 128 && metaDefault.height === 128, "default avatar is 128x128");

      // 2. Explicit modal size (size=180 -> 180x180)
      const req180 = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=180", {
        headers: { Authorization: `Bearer ${screenToken}` },
      });
      const res180 = await avatarRoute.GET(req180);
      ok(res180.status === 200, "avatar route returns 200 for size=180");
      const meta180 = await sharp(Buffer.from(await res180.arrayBuffer())).metadata();
      ok(meta180.width === 180 && meta180.height === 180, "size=180 produces exactly 180x180 image for modal well");

      // 3. Overflow clamping (size=50000 -> clamped to 512x512)
      const reqHigh = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=50000", {
        headers: { Authorization: `Bearer ${screenToken}` },
      });
      const resHigh = await avatarRoute.GET(reqHigh);
      const metaHigh = await sharp(Buffer.from(await resHigh.arrayBuffer())).metadata();
      ok(metaHigh.width === 512 && metaHigh.height === 512, "oversized request clamped to 512x512 max");

      // 4. Underflow clamping (size=10 -> clamped to 32x32)
      const reqLow = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=10", {
        headers: { Authorization: `Bearer ${screenToken}` },
      });
      const resLow = await avatarRoute.GET(reqLow);
      const metaLow = await sharp(Buffer.from(await resLow.arrayBuffer())).metadata();
      ok(metaLow.width === 32 && metaLow.height === 32, "undersized request clamped to 32x32 min");

      // 5. Malformed size (size=junk -> falls back to default 128x128)
      const reqJunk = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=junk", {
        headers: { Authorization: `Bearer ${screenToken}` },
      });
      const resJunk = await avatarRoute.GET(reqJunk);
      const metaJunk = await sharp(Buffer.from(await resJunk.arrayBuffer())).metadata();
      ok(metaJunk.width === 128 && metaJunk.height === 128, "junk size string falls back to default 128x128");

      // 6. Unauthenticated request rejected with 401
      const reqUnauthed = new NextRequest("http://localhost/api/devices/avatar?id=p_sam&size=180");
      const resUnauthed = await avatarRoute.GET(reqUnauthed);
      ok(resUnauthed.status === 401, "unauthenticated avatar request returns 401");
    } finally {
      globalThis.fetch = origFetch;
      if (origSubwaveApiUrl !== undefined) {
        process.env.SUBWAVE_API_URL = origSubwaveApiUrl;
      } else {
        delete process.env.SUBWAVE_API_URL;
      }
    }
  }
} catch (e: any) {
  ok(false, "the behaviour suite ran", String(e?.message || e).split("\n")[0]);
} finally {
  cleanup();
}

console.log(`  ${passed}/${passed + failed} device-route behaviour assertions passed`);
if (failed > 0) process.exit(1);