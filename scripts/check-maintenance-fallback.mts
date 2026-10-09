// Maintenance mode must still work when the database is down.
//
// It exists for exactly one situation — the station being worked on — and that
// situation is the one that used to break it. Both readers asked Postgres
// directly and swallowed the failure:
//
//   - /api/settings answered its catch block with no `maintenanceMode` key at
//     all. The player only adopts the value when it is a boolean
//     (`typeof d.maintenanceMode === "boolean"`), so an absent key is not a
//     neutral "unknown" — it left the state at its initialiser, false, and the
//     maintenance notice vanished.
//   - /api/stream wrapped the same check in an empty `catch {}`, so an outage
//     during maintenance served the audio anyway. The station was supposed to
//     be dark and was not.
//
// So maintenance state is mirrored into the local SQLite cache and read back
// when Postgres cannot be asked.
//
// The part that is easy to get wrong is the direction of the failure. A
// maintenance notice that defaults to OFF during an outage is a bug. One that
// defaults to ON is worse: a three-second database blip would take the station
// dark, which is a worse outage than the one being fixed. So the contract here
// is deliberately three-valued — true, false, or "we do not know" — and "we do
// not know" must never be collapsed into either of the other two. That is what
// most of these assertions are about.
//
// Run: node scripts/check-maintenance-fallback.mts (wired as `npm run check:maintenance`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrub } from "./lib/tsx-scan.mts";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
  }
}

// ------------------------------------------------------------------ the route

const settingsPath = path.join(REPO, "app/api/settings/route.ts");
const settingsRaw = readFileSync(settingsPath, "utf8");
const settings = scrub(settingsRaw);

{
  // The failure path must consult the mirror. This is the whole bug.
  const catchBlock = settings.match(/catch \(error\)[\s\S]*?\n {2}\}\n\}/);
  ok(catchBlock !== null, "the settings route still has a catch block for an unreachable database");
  const block = catchBlock?.[0] ?? "";

  ok(/cachedMaintenance\(\)/.test(block), "and it asks the local mirror before answering");
  ok(/\.\.\.cached/.test(block), "and spreads that answer into the response");
  // The specific original defect: an absent key read as false.
  ok(
    !/maintenanceMode:\s*false/.test(block),
    "and does not hardcode maintenance off in the outage path"
  );
  // Absent from the mirror must stay absent, not become a value.
  ok(
    /if \(typeof rows\.maintenanceMode === "string"\)/.test(settingsRaw),
    "an unmirrored key stays absent rather than being invented"
  );

  // The mirror is written from the success path, so a deleted cache repairs
  // itself without waiting for an admin to touch the toggle.
  const success = settings.split(/catch \(error\)/)[0];
  ok(/mirrorMaintenance\(/.test(success), "a successful read refreshes the mirror");
  ok(
    /await\s+mirrorMaintenance\(\{[\s\S]*?maintenanceMode:[\s\S]*?maintenanceMessage:/.test(settings),
    "and it mirrors both the switch and the message"
  );
}

// ------------------------------------------------------------- the stream gate

const streamRaw = readFileSync(path.join(REPO, "app/api/stream/route.ts"), "utf8");
const stream = scrub(streamRaw);

{
  ok(/readMaintenance\(\)/.test(stream), "the stream route reads through the maintenance helper");
  const helper = streamRaw.match(/async function readMaintenance[\s\S]*?\n\}/);
  ok(helper !== null, "and the helper exists");
  const h = helper?.[0] ?? "";

  ok(/prisma\.setting\.findUnique/.test(h), "it asks Postgres first");
  ok(/catch/.test(h), "and has a failure path");
  // BOTH halves: the dynamic import and the call. Checking only for the call
  // passed a mutation that deleted the import line — the identifier is still
  // referenced, so the regex matched, and the code would have thrown a
  // ReferenceError into the inner catch and quietly answered "unknown" on every
  // request instead. A check that finds the word but not the working is the
  // same trap as the hook checkers that reported zero findings.
  ok(
    /await import\("@\/lib\/lite-cache"\)/.test(h) && /liteGetSettings\(/.test(h),
    "which falls back to the local mirror, importing it rather than assuming the symbol"
  );
  // The three-valued contract, in the type itself.
  ok(
    /mode:\s*boolean \| null/.test(h),
    "and its result is three-valued — a boolean OR null for unknown"
  );
  ok(
    /typeof rows\.maintenanceMode === "string"\s*\?\s*rows\.maintenanceMode === "true"\s*:\s*null/.test(h),
    "with the mirror's absent key mapping to null, not to false"
  );
  // Admins still pass through, or an operator could not verify their own work.
  ok(/maintenance\.mode === true && !user\.isAdmin/.test(stream), "and admins still pass through");
  // A refusal must be a 503, not a thrown error — throwing here would take the
  // whole stream down rather than showing the notice. Read from the RAW file:
  // scrub() blanks string bodies, so the notice text is not in the scrubbed
  // copy and this assertion could never match.
  ok(
    /maintenance\.message \|\| "Station down for maintenance — back soon\."[\s\S]{0,40}\{\s*status:\s*503\s*\}/.test(streamRaw),
    "and refuses with a 503 carrying the notice, not an exception"
  );
}

// --------------------------------------------------------------- the mirror

const liteRaw = readFileSync(path.join(REPO, "lib/lite-cache.ts"), "utf8");
const lite = scrub(liteRaw);
const liteText = liteRaw; // DDL and literals live in string bodies.

{
  ok(
    /CREATE TABLE IF NOT EXISTS "Setting" \("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL\)/.test(liteText),
    "the mirror table is created alongside the other cache tables"
  );
  // ensureCacheTables is what liteClient() runs, so this is the only place the
  // DDL has to be or a fresh install has no table.
  const ddlAt = liteText.indexOf('CREATE TABLE IF NOT EXISTS "Setting"');
  const ensureAt = liteText.indexOf("async function ensureCacheTables");
  ok(ensureAt >= 0 && ddlAt > ensureAt, "and it lives inside ensureCacheTables, which liteClient() runs");

  ok(/export async function liteGetSettings/.test(lite), "there is a reader");
  ok(/export async function litePutSettings/.test(lite), "and a writer");
  // A cache is disposable; every accessor must swallow its own failure.
  for (const fn of ["liteGetSettings", "litePutSettings"]) {
    const body = lite.match(new RegExp(`export async function ${fn}[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    ok(body.length > 0, `${fn} was found`, body.slice(0, 60));
    ok(/catch\s*\{/.test(body), `${fn} swallows its own failures — a broken cache must not break the feature`);
  }
}

{
  // Write-through on save. Reading on a schedule would be the wrong way round:
  // turning maintenance ON is the moment Postgres is most likely to be the
  // thing being worked on, so the outage follows the save.
  const admin = readFileSync(path.join(REPO, "app/api/admin/settings/route.ts"), "utf8");
  ok(
    /key === "maintenanceMode" \|\| key === "maintenanceMessage"/.test(admin) && /litePutSettings/.test(admin),
    "an admin save mirrors the switch immediately, not on the next read"
  );
}

// ------------------------------------------------- the checker checks itself

{
  // A reader that cannot tell "unknown" from "false" is the original bug wearing
  // a different hat. Pin the distinction directly.
  const collapses = ['maintenanceMode: false', 'mode: false', 'return { mode: false, message: "" }'];
  ok(
    collapses.some((c) => !c.includes("null")),
    "the fixtures below include the collapsing forms to be rejected"
  );

  const streamCollapse = `async function readMaintenance() {
  try {
    const m = await prisma.setting.findUnique({ where: { key: "maintenanceMode" } });
    return { mode: m?.value === "true", message: "" };
  } catch {
    return { mode: false, message: "" };
  }
}`;
  ok(
    /mode:\s*boolean \| null/.test(streamCollapse) === false,
    "a two-valued helper would not satisfy the three-valued contract"
  );

  // Absent-from-mirror must survive as absent, in the settings route too.
  ok(
    /if \(typeof rows\.maintenanceMessage === "string"\)/.test(settingsRaw),
    "the message is only reported when it was actually mirrored"
  );
}

console.log(`  ${passed}/${passed + failed} maintenance-fallback assertions passed`);
if (failed) process.exit(1);