// Sub/Wave config assembly: the /api suffix, the env fallbacks, and the auth
// header.
//
// The URL normalisation has a specific failure that never looks like a config
// error: Caddy forwards only /api/* to the controller, so a missing suffix (or
// a doubled one) produces a 404 served by the web UI instead. The admin panel
// saves whatever the operator types, so this is where a typo becomes a silent
// outage an hour later.
//
// getSubwaveConfig reads the database when it can and falls back to env when it
// cannot, which is what lets the proxy keep trying while the database sleeps.
// Both halves are exercised: env-only (no database), and env-overridden-by-a
// saved setting.
//
// Run: npm run check:subwave
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();
const saved = { ...process.env };

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

// ---- URL normalisation: exactly one /api suffix, from any input ----
// getSubwaveConfig needs a database, so run it against a throwaway sqlite one
// built from the repo schema (same trick as the backup and cache suites).
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-subwave-"));
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
const hash = crypto.createHash("sha256").update(schema).digest("hex");
const hashFile = path.join(clientDir, "schema.sha256");
if ((await fs.readFile(hashFile, "utf8").catch(() => "")) !== hash) {
  await fs.rm(clientDir, { recursive: true, force: true });
  await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], { cwd: REPO, timeout: 180000 });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(hashFile, hash);
}
process.env.DATABASE_URL = `file:${path.join(tmp, "main.db")}`;
process.env.DB_PROVIDER = "sqlite";
await run(path.join(REPO, "node_modules", ".bin", "prisma"),
  ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
  { cwd: REPO, timeout: 120000, env: process.env });

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient();

// lib/subwave imports lib/prisma, which builds its client at module load from
// DATABASE_URL. Importing it earlier would bind a client with no URL, every read
// would throw, and the module's own catch would silently hand back env-only
// config — so every "saved setting wins" assertion below would pass for the
// wrong reason.
const subwave = await import("../lib/subwave.ts");

// ---- the auth header ----
{
  ok(subwave.subwaveAdminAuth({ adminUser: "admin", adminPass: "s3cret" }) === "Basic " + Buffer.from("admin:s3cret").toString("base64"), "credentials become a basic auth header");
  ok(subwave.subwaveAdminAuth({ adminUser: "", adminPass: "s3cret" }) === null, "no user means no header, not an empty one");
  ok(subwave.subwaveAdminAuth({ adminUser: "admin", adminPass: "" }) === null, "no password means no header");
  ok(subwave.subwaveAdminAuth({ adminUser: "", adminPass: "" }) === null, "neither means no header");
  // A colon in the password must not be read as the user/password separator.
  const tricky = subwave.subwaveAdminAuth({ adminUser: "admin", adminPass: "pa:ss:word" })!;
  ok(Buffer.from(tricky.slice(6), "base64").toString() === "admin:pa:ss:word", "a colon inside the password survives the round trip");
}

// ---- with no saved settings, env wins ----
{
  delete process.env.SUBWAVE_API_URL;
  process.env.SUBWAVE_ADMIN_USER = "envuser";
  process.env.SUBWAVE_ADMIN_PASS = "envpass";
  const cfg = await subwave.getSubwaveConfig();
  ok(cfg.adminUser === "envuser" && cfg.adminPass === "envpass", "env credentials are used when nothing is saved");
  ok(cfg.apiUrl === "", "an unset url is empty rather than invented");
  // The saved settings table exists and is empty here, which also proves the
  // database read path runs without throwing.
  ok(cfg.spotifyClientId === "", "absent keys come back empty");
}
await db.$disconnect();

// ---- the saved setting wins over env, and the suffix is normalised once ----
const urlCases: [string, string, string][] = [
  ["https://radio.example.com", "https://radio.example.com/api", "a bare host gains /api"],
  ["https://radio.example.com/api", "https://radio.example.com/api", "an existing /api is left alone"],
  ["https://radio.example.com/", "https://radio.example.com/api", "a trailing slash is trimmed first"],
  ["https://radio.example.com/api/", "https://radio.example.com/api", "a trailing slash after /api is trimmed"],
  ["https://radio.example.com:7700", "https://radio.example.com:7700/api", "an explicit port is preserved"],
  ["http://192.168.1.10:4040", "http://192.168.1.10:4040/api", "a LAN address with a port works"],
  ["  https://radio.example.com  ", "https://radio.example.com/api", "surrounding spaces are ignored"],
];
for (const [saved_, expected, label] of urlCases) {
  const db2 = new PrismaClient();
  await db2.setting.upsert({ where: { key: "subwaveApiUrl" }, update: { value: saved_ }, create: { key: "subwaveApiUrl", value: saved_ } });
  const cfg = await subwave.getSubwaveConfig();
  ok(cfg.apiUrl === expected, `${label} (got ${cfg.apiUrl})`);
  // The invariant that matters: never doubled, never bare, always exactly one.
  ok(!cfg.apiUrl.endsWith("/api/api"), `${label} does not double the suffix`);
  ok(cfg.apiUrl.endsWith("/api"), `${label} ends in /api`);
  await db2.setting.deleteMany({ where: { key: "subwaveApiUrl" } });
  await db2.$disconnect();
}

// ---- a secret saved in the table is used, and a blank falls back to env ----
{
  const db3 = new PrismaClient();
  await db3.setting.createMany({
    data: [
      { key: "subwaveApiUrl", value: "" },
      { key: "subwaveAdminUser", value: "saveduser" },
      { key: "subwaveAdminPass", value: "savedpass" },
    ],
  });
  process.env.SUBWAVE_API_URL = "https://env.example.com";
  const cfg = await subwave.getSubwaveConfig();
  ok(cfg.adminUser === "saveduser", "a saved setting overrides env");
  ok(cfg.apiUrl === "https://env.example.com/api", "a blank saved value falls back to env");
  // Pasted values carry stray whitespace; untrimmed, a base URL cannot be
  // parsed by fetch and the station silently loses Sub/Wave.
  process.env.SUBWAVE_API_URL = "  https://env.example.com/api\n";
  const paddedEnv = await subwave.getSubwaveConfig();
  ok(paddedEnv.apiUrl === "https://env.example.com/api", "a padded env url is trimmed, newline and all");
  await db3.setting.deleteMany({ where: { key: { in: ["subwaveApiUrl", "subwaveAdminUser", "subwaveAdminPass"] } } });
  await db3.$disconnect();
}

// ---- station password has no env fallback: it must not be guessed at ----
{
  const db4 = new PrismaClient();
  delete process.env.SUBWAVE_STREAM_URL;
  const cfg = await subwave.getSubwaveConfig();
  ok(cfg.stationPassword === "", "an unset station password is empty, never defaulted");
  await db4.$disconnect();
}

console.log(`  ${passed}/${passed + failed} subwave assertions passed`);
await cleanup();
Object.assign(process.env, saved);
process.exit(failed > 0 ? 1 : 0);
