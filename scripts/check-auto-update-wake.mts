// What happens to automatic updates when the database is asleep.
//
// This is not hypothetical: the station is built to let its database sleep, so
// an update tick meeting a sleeping database is the normal case, not an edge
// one. Two things had to be true and neither was:
//
//   1. the tick WAKES the database, because nothing else would — the wake loop
//      is only reachable from an incoming request, so with nobody visiting an
//      update would simply never get its chance;
//   2. a failed read must not be mistaken for "the operator turned automatic
//      updates off". It was, and the value was remembered, after which an idle
//      station never re-read the setting and updates stopped for good.
//
// The database here is a throwaway sqlite one, stubbed to fail on demand, so
// "asleep" is simulated rather than waited for.
//
// Run: npm run check:auto-update-wake  (part of `npm run check:db`)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();
const savedEnv = { ...process.env };

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-autowake-"));
const clientDir = path.join(REPO, ".test-client");
const schemaPath = path.join(REPO, "prisma", ".gen-test.prisma");
const cleanup = async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fs.rm(schemaPath, { force: true }).catch(() => {});
};
process.on("exit", () => { void cleanup(); });

await run("node", [path.join(REPO, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
let schema = await fs.readFile(schemaPath, "utf8");
schema = schema.replace(
  /generator client \{[\s\S]*?\}/,
  `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
);
await fs.writeFile(schemaPath, schema);
const hash = createHash("sha256").update(schema).digest("hex");
const hashFile = path.join(clientDir, "schema.sha256");
if ((await fs.readFile(hashFile, "utf8").catch(() => "")) !== hash) {
  await fs.rm(clientDir, { recursive: true, force: true });
  await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], { cwd: REPO, timeout: 180000 });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(hashFile, hash);
}
process.env.DATABASE_URL = `file:${path.join(tmp, "main.db")}`;
process.env.DB_PROVIDER = "sqlite";
process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY?.trim() || "d".repeat(64);
await run(path.join(REPO, "node_modules", ".bin", "prisma"),
  ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
  { cwd: REPO, timeout: 120000, env: process.env });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();
(globalThis as any).prisma = db;

// An app directory with no job file and no staged update, so the tick's own
// housekeeping is inert and we are measuring only the wake behaviour.
const appDir = path.join(tmp, "app");
await fs.mkdir(appDir, { recursive: true });

await db.setting.createMany({
  data: [
    { key: "autoUpdateEnabled", value: "true" },
    { key: "autoUpdateStart", value: "03:00" },
    { key: "autoUpdateEnd", value: "04:00" },
  ],
});

const auto = await import("../lib/auto-update.ts");

/**
 * Model a suspended database faithfully.
 *
 * Reads fail until a connection is established — which is exactly what waking a
 * suspended instance means — and succeed afterwards. An earlier version failed
 * reads unconditionally, which made the tick's re-read after waking impossible
 * and tested a situation that cannot occur.
 *
 * `canWake: false` is the harsher case: even the raw probe is refused, so the
 * instance is genuinely gone rather than merely asleep.
 */
function makeAsleep(canWake: boolean) {
  const client: any = (globalThis as any).prisma;
  const models = ["setting", "streamSession"] as const;
  const saved: Record<string, any> = {};
  for (const m of models) saved[m] = client[m];
  const savedRaw = client.$queryRaw;
  const savedRawUnsafe = client.$queryRawUnsafe;
  let woken = false;

  const boom = () => {
    throw new Error("Connection refused: the database is asleep");
  };
  // While asleep, any property access yields a function that refuses. Once woken,
  // it must hand back the REAL delegate — returning the proxy from inside the
  // proxy's own handler is an infinite loop.
  for (const m of models) {
    const real = saved[m];
    client[m] = new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (woken) return real[prop];
          return () => boom();
        },
      }
    );
  }
  // The raw probe is the connection attempt: it is what "waking" looks like.
  client.$queryRaw = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (!canWake) boom();
    woken = true;
    return (savedRaw as any).call(client, strings, ...vals);
  };
  client.$queryRawUnsafe = (q: string) => {
    if (!canWake) boom();
    woken = true;
    return (savedRawUnsafe as any).call(client, q);
  };

  return () => {
    for (const m of models) client[m] = saved[m];
    client.$queryRaw = savedRaw;
    client.$queryRawUnsafe = savedRawUnsafe;
  };
}

// ---- the settings read must say it failed, rather than claiming "off" ----
{
  const awake = await auto.readAutoUpdateSettings();
  ok(awake.ok === true, "a readable database reports ok");
  ok(awake.settings.enabled === true, "and the real value comes through");
  ok(awake.settings.start === "03:00" && awake.settings.end === "04:00", "as does the window");

  const restore = makeAsleep(true);
  const asleep = await auto.readAutoUpdateSettings();
  restore();
  ok(asleep.ok === false, "a database that will not answer reports NOT ok");
  ok(asleep.settings.enabled === false, "the fallback is inert, which is why ok has to be checked");
}
{
  // Genuinely switched off must still read as off, not as a failure.
  await db.setting.update({ where: { key: "autoUpdateEnabled" }, data: { value: "false" } });
  const off = await auto.readAutoUpdateSettings();
  ok(off.ok === true && off.settings.enabled === false, "switched off is ok:true with enabled false — not a failure");
  await db.setting.update({ where: { key: "autoUpdateEnabled" }, data: { value: "true" } });
}

/** Run the tick with the console captured, returning both what it decided and what it said. */
async function tickAsleep(canWake: boolean, restore: () => void) {
  const said: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
  let decision: any = null;
  try {
    decision = await auto.runAutoUpdateTick(appDir);
  } finally {
    console.log = realLog;
    restore();
  }
  return { decision, said: said.join("\n") };
}

// ---- a sleeping database is woken, and the tick carries on ----
{
  const restore = makeAsleep(true);
  const { decision, said } = await tickAsleep(true, restore);
  ok(decision.start === false, "a tick that had to wake the database starts no update on this pass");
  ok(/was asleep/i.test(said), `and announces the wake, so an operator can see it (logged: ${JSON.stringify(said.slice(0, 90))})`);
  // The important part: it got past the guard and made a real decision rather
  // than giving up. Before the fix this is where it returned early.
  ok(!/would not wake/i.test(decision.reason || ""), `it does not give up on the database (got "${decision.reason}")`);
  ok(!/unreadable/i.test(decision.reason || ""), `and the re-read succeeded after waking (got "${decision.reason}")`);
}

// ---- a database that will not wake is reported, not swallowed ----
{
  const restore = makeAsleep(false);
  const decision = await auto.runAutoUpdateTick(appDir);
  restore();
  ok(decision.start === false, "a database that will not wake starts nothing");
  ok(/would not wake/i.test(decision.reason || ""), `and says so plainly (got "${decision.reason}")`);
}

// ---- THE REGRESSION: a failed read must not switch updates off for good ----
// If the failure latched "off", the next tick would take the early return for an
// idle station and never look at the database again. Two ticks, still asleep:
// the second must still be trying, not declaring the feature switched off.
{
  const restore = makeAsleep(true);
  const first = await tickAsleep(true, restore);
  const restore2 = makeAsleep(true);
  const second = await tickAsleep(true, restore2);
  ok(/was asleep/i.test(first.said), "the first tick wakes it");
  ok(/was asleep/i.test(second.said),
    "and so does the second — proof the setting was never latched to off");
  ok(!/idle and auto-update off/i.test(second.decision.reason || ""),
    `the second tick still tries rather than believing updates are off (got "${second.decision.reason}")`);
}

// ---- and the same must hold once the database answers again ----
{
  const decision = await auto.runAutoUpdateTick(appDir);
  // With the database readable this tick gets past the guard for real, so it
  // either decides legitimately or fails later for an unrelated reason. What it
  // must never do is claim the operator turned updates off.
  ok(!/idle and auto-update off/i.test(decision.reason || ""),
    `with the database answering, the tick reads the real setting (got "${decision.reason}")`);
}

// ---- structural: the remembered value is guarded by the read succeeding ----
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/auto-update.ts", import.meta.url), "utf8");
  const guardAt = src.indexOf("if (!read.ok)");
  const latchAt = src.indexOf("lastKnownAutoEnabled = settings.enabled");
  ok(guardAt !== -1, "the tick checks whether the read succeeded");
  ok(latchAt !== -1, "and remembers the value");
  ok(guardAt < latchAt, "the check comes first, so a failure can never latch a default");
  ok(/wakeDbInBackground\(\)/.test(src), "the tick knocks the database awake itself");
  ok(
    /const woke = await wakeDbInBackground/.test(src),
    "and waits for the result rather than firing and hoping — otherwise it wakes a database that is asleep again by the next tick"
  );
}

await db.$disconnect();
console.log(`  ${passed}/${passed + failed} auto-update-wake assertions passed`);
await cleanup();
Object.assign(process.env, savedEnv);
process.exit(failed > 0 ? 1 : 0);
