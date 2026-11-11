#!/usr/bin/env node
// Generate the SQLite Prisma client used by the lite write-back cache
// (lib/lite-cache.ts). Same models as the app schema, sqlite provider —
// gen-schema.mjs performs the swap, exactly like the test client.
//
// Hash-gated and fast when fresh; runs as part of `npm run dev` and
// `npm run build` so the client exists wherever the app runs (including the
// VPS, which builds on deploy). The lite module lazy-loads this client and
// falls back to direct Postgres when the files are absent, so stations that
// never enable the cache never notice it missing.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const run = promisify(execFile);
const REPO = process.cwd();
const clientDir = path.join(REPO, "prisma", "lite-client");
const hashFile = path.join(clientDir, "schema.sha256");
const schemaPath = path.join(REPO, "prisma", ".gen-cache.prisma");

export async function ensureCacheClient() {
  await run(process.execPath, [path.join(REPO, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
  let schema = await fs.readFile(schemaPath, "utf8");
  schema = schema.replace(
    /generator client \{[\s\S]*?\}/,
    `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
  );
  await fs.writeFile(schemaPath, schema);
  const hash = crypto.createHash("sha256").update(schema).digest("hex");
  const cached = await fs.readFile(hashFile, "utf8").catch(() => "");
  if (cached.trim() === hash && (await fs.stat(path.join(clientDir, "index.js")).catch(() => null))) {
    return false;
  }
  await fs.rm(clientDir, { recursive: true, force: true });
  await run(path.join(REPO, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], {
    cwd: REPO,
    timeout: 180000,
  });
  await fs.mkdir(clientDir, { recursive: true });
  await fs.writeFile(hashFile, hash);
  return true;
}

const direct = process.argv[1] && process.argv[1].endsWith("ensure-cache-client.mjs");
if (direct) {
  const generated = await ensureCacheClient().catch((e) => {
    console.error(`ensure-cache-client: ${e.message}`);
    process.exit(1);
  });
  console.log(generated ? "(lite cache client generated)" : "(lite cache client fresh)");
}
