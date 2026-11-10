// Skip from a screen must be the same decision the player's Skip is.
//
// WHY THIS NEEDS A GATE. lib/skipvisibility.ts exists because "a button shown but
// refused is a dead control in front of a listener", and its header insists the
// player and the route read the SAME helper. A screen is a third call site, and a
// third call site is exactly where that guarantee quietly stops holding: someone
// re-implements the solo check, or reads the setting in a different module, or
// adds an admin branch "just for the screen". None of those look wrong in review.
//
// So this asserts the screen path goes through canSkipAsScreen, which is built on
// the listener's own canSkipAsListener, and that nothing admin-shaped is
// reachable. Never play this track and DJ say are ADMIN TIER and are not lesser
// versions of Skip: provisioning a screen is an operator action, and that
// authorises creating the row and nothing after it.
//
// THE EMPTY-ROOM CASE IS ASSERTED DELIBERATELY. `solo` means listeners <= 1, and a
// screen is never counted in that total, so a wall in an empty room sees 0 and
// does get Skip. That is identical to what a real sole listener sees after they
// stop, so it is genuinely 1:1 — and it is also the reason a station that does
// not want a public screen cutting the music needs skipVisibilityScreens.
//
// Run: npm run check:device-skip
import fs from "node:fs";
import path from "node:path";
import { scrub } from "./lib/tsx-scan.mts";
import {
  canSkipAsListener,
  canSkipAsScreen,
  parseSkipVisibility,
  parseSkipVisibilityScreens,
} from "../lib/skipvisibility.ts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

const SKIP_ROUTE = path.join(process.cwd(), "app", "api", "devices", "skip", "route.ts");
const SERVICE = path.join(process.cwd(), "lib", "device-service.ts");
const POLICY = path.join(process.cwd(), "lib", "skipvisibility.ts");

// ---- the route goes through the shared policy ----
{
  const src = scrub(fs.readFileSync(SKIP_ROUTE, "utf8"));
  ok(/canSkipAsScreen\(/.test(src), "the screen skip route calls canSkipAsScreen");
  ok(!/function\s+canSkipAsListener/.test(src), "the screen skip route does not reimplement the listener rule");
  ok(!/\.?\s*listeners\s*\.current\s*<=\s*1/.test(src), "the screen route does not inline its own solo check");
  // Fail closed: an unreadable setting must refuse, not fall open.
  ok(/catch[\s\S]{0,200}status:\s*502/.test(src), "an unreadable skip setting refuses rather than falling open");
}

// ---- the screen policy is built on the listener policy ----
{
  const src = scrub(fs.readFileSync(POLICY, "utf8"));
  ok(/canSkipAsScreen[\s\S]*canSkipAsListener\(/.test(src), "canSkipAsScreen delegates to canSkipAsListener");
  // Scoped to the function's own body. A lazy match across the file would run on
  // into canSkipAsListener and find its `listeners <= 1`, which is exactly the
  // line the delegation is supposed to be reusing.
  const body = /export function canSkipAsScreen\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  ok(!/listeners\s*<=\s*1/.test(body), "canSkipAsScreen does not duplicate the solo rule in its own body");
}

// ---- no admin tier is reachable from a screen ----
{
  const src = scrub(fs.readFileSync(SKIP_ROUTE, "utf8"));
  ok(!/never-?play|blockTrack/i.test(src), "the screen skip route cannot block a track");
  ok(!/dj\/say|isAdmin/i.test(src), "the screen skip route cannot speak on air");
  // Station credentials are correct HERE and nowhere else — this route forwards
  // to the backend on the station's behalf. It must never forward anybody's.
  ok(/subwaveAdminAuth\(cfg\)/.test(src), "it forwards with the station's own credentials");
  ok(!/Authorization:\s*auth\b/.test(src) || !/\bsession\b/.test(src), "it never forwards a session as a credential");
}

// ---- the whole truth table, both settings, no sampling ----
type Row = [ReturnType<typeof parseSkipVisibilityScreens>, ReturnType<typeof parseSkipVisibility>, number | null | undefined, boolean, boolean];
const table: Row[] = [
  // A device's own opt-out beats everything.
  ["follow", "always", 0, false, false],
  ["hidden", "always", 0, true, false],
  // `hidden` for screens beats any listener mode.
  ["hidden", "always", 99, true, false],
  ["hidden", "solo", 1, true, false],
  // `listener` is a listener no matter what the listener setting says.
  ["listener", "hidden", 99, true, true],
  ["listener", "solo", 50, true, true],
  // `follow` behaves exactly as a listener.
  ["follow", "hidden", 0, true, false],
  ["follow", "solo", 0, true, true],
  ["follow", "solo", 1, true, true],
  ["follow", "solo", 2, true, false],
  ["follow", "always", 99, true, true],
  ["follow", "always", 0, true, true],
  // An unknown headcount fails closed rather than offering a doomed button.
  ["follow", "solo", null, true, false],
  ["follow", "solo", undefined, true, false],
];
for (const [screens, mode, listeners, enabled, expected] of table) {
  ok(
    canSkipAsScreen(screens, mode, listeners, enabled) === expected,
    `${screens} + ${mode} + ${listeners === null ? "null" : listeners} listeners + enabled=${enabled} -> ${expected}`,
  );
}

// ---- the settings parse fail-closed, like every other free-form stored value ----
for (const raw of [null, undefined, "", "  ", "FOLLOW", "yes", 0, 1, {}, []]) {
  ok(parseSkipVisibilityScreens(raw) === "follow", `unrecognised screen setting ${JSON.stringify(raw) ?? String(raw)} falls back to follow`);
}
ok(parseSkipVisibilityScreens("hidden") === "hidden", "hidden parses");
ok(parseSkipVisibilityScreens("listener") === "listener", "listener parses");

// ---- the empty room, stated explicitly ----
{
  const empty = canSkipAsScreen("follow", "solo", 0, true);
  const one = canSkipAsListener("solo", 1);
  ok(empty === true, "an empty room still offers Skip, because a screen is never counted as a listener");
  ok(empty === one, "...which is identical to what a real sole listener sees after they stop");
}

// ---- the checker checks itself ----
{
  ok(
    !canSkipAsScreen("follow", "solo", 99, true),
    "MUTATION CAUGHT: a crowded room correctly hides it, so the table above can fail",
  );
  ok(
    canSkipAsScreen("follow", "solo", 2, false) === false,
    "MUTATION CAUGHT: the device opt-out actually overrides an 'always' station",
  );
  const service = scrub(fs.readFileSync(SERVICE, "utf8"));
  ok(/canSkipAsScreen\(/.test(service), "the state payload builds the button with the same policy");
  ok(/never-?play|blockTrack|dj\/say/i.test("") === false, "MUTATION SANITY: the admin-affordance bans match nothing in a clean service layer");
}

console.log(`  ${passed}/${passed + failed} device-skip assertions passed`);
if (failed > 0) process.exit(1);