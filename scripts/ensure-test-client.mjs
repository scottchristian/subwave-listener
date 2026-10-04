// Shared by the DB-backed check scripts: ensure a throwaway sqlite Prisma
// client exists (hash-gated, reused across runs) and return its directory.
// Generating into the repo would clobber node_modules; generating nowhere
// leaves imports unresolvable. So: repo-local .test-client (gitignored),
// schema via gen-schema.mjs, tables via db push.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const run = promisify(execFile);

export async function ensureTestClient(repoRoot, databaseUrl) {
  const clientDir = path.join(repoRoot, ".test-client");
  const hashFile = path.join(clientDir, "schema.sha256");
  const schemaPath = path.join(repoRoot, "prisma", ".gen-test.prisma");

  await run(process.execPath, [path.join(repoRoot, "scripts", "gen-schema.mjs"), "sqlite", schemaPath]);
  let schema = await fs.readFile(schemaPath, "utf8");
  schema = schema.replace(
    /generator client \{[\s\S]*?\}/,
    `generator client {\n  provider = "prisma-client-js"\n  output = "${clientDir}"\n}`
  );
  await fs.writeFile(schemaPath, schema);
  try {
    const hash = crypto.createHash("sha256").update(schema).digest("hex");
    const cached = await fs.readFile(hashFile, "utf8").catch(() => "");
    const indexExists = await fs.stat(path.join(clientDir, "index.js")).catch(() => null);
    if (cached.trim() !== hash || !indexExists) {
      await fs.rm(clientDir, { recursive: true, force: true });
      await run(path.join(repoRoot, "node_modules", ".bin", "prisma"), ["generate", "--schema", schemaPath], {
        cwd: repoRoot,
        timeout: 180000,
      });
      await fs.mkdir(clientDir, { recursive: true });
      await fs.writeFile(hashFile, hash);
      console.log("  (test prisma client generated)");
    } else {
      console.log("  (test prisma client reused)");
    }
    await run(
      path.join(repoRoot, "node_modules", ".bin", "prisma"),
      ["db", "push", "--schema", schemaPath, "--skip-generate", "--accept-data-loss"],
      {
        cwd: repoRoot,
        timeout: 120000,
        env: { ...process.env, DATABASE_URL: databaseUrl, DB_PROVIDER: "sqlite" },
      }
    );
  } finally {
    await fs.rm(schemaPath, { force: true }).catch(() => {});
  }
  return clientDir;
}
