import path from "node:path";
import { defineConfig } from "prisma/config";
import { resolveDatabaseUrl } from "./lib/database-url.ts";

// Prisma 7 does not read .env files for the CLI. Load the same file the app
// reads, with .env as a fallback; variables already in the environment win, so
// deploy.sh's exported DATABASE_URL is never overridden by a stale file.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile?.(file);
  } catch {
    // Missing file is normal: CI and tests pass the URL in the environment.
  }
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: resolveDatabaseUrl(process.env.DATABASE_URL, path.join(process.cwd(), "prisma")),
  },
});
