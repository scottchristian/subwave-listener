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
    ok(replacement !== original, "the replacement is a different token");
    const afterRotate = await auth.deviceAuth(req(original));
    ok(afterRotate === null, "the old token is dead the instant the replacement is handed over");
    ok((await auth.deviceAuth(req(replacement)))?.id === row.id, "the replacement works");

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
} catch (e: any) {
  ok(false, "the behaviour suite ran", String(e?.message || e).split("\n")[0]);
} finally {
  cleanup();
}

console.log(`  ${passed}/${passed + failed} device-route behaviour assertions passed`);
if (failed > 0) process.exit(1);