#!/usr/bin/env node
// Generate a provider-specific Prisma schema from the canonical one.
// This is the answer to "we don't maintain two schemas": the models are
// written once, and only the datasource block is swapped.
import fs from "node:fs";

const [, , provider, out] = process.argv;
if (!provider || !out) {
  console.error("usage: gen-schema.mjs <sqlite|postgresql> <outfile>");
  process.exit(2);
}
const src = fs.readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

// The URL is not part of the schema any more (Prisma 7 reads it from
// prisma.config.ts), so the swap only has to pin the provider.
const swapped = src.replace(
  /datasource\s+db\s*\{[\s\S]*?\}/,
  `datasource db {\n  provider = "${provider}"\n}`
);

if (!swapped.includes(`provider = "${provider}"`)) {
  console.error("failed to swap datasource block");
  process.exit(1);
}
fs.writeFileSync(out, swapped);
console.log(`wrote ${out} (provider=${provider}, models untouched)`);
