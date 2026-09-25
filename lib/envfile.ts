import { promises as fs } from "node:fs";
import path from "node:path";

export const ENV_FILE =
  process.env.STATION_ENV_FILE ||
  process.env.CAUSEWAY_ENV_FILE ||
  path.join(process.cwd(), ".env.local");

// Rewrite KEY="value" lines in the server .env.local, preserving every other
// line byte-for-byte. Values with empty string remove the line (falls back to
// process env). Always backs up first. Throws human-readable on failure.
export async function updateEnvFile(
  vars: Record<string, string>,
  file = ENV_FILE
): Promise<{ updated: string[]; backup: string }> {
  const raw = await fs.readFile(file, "utf8").catch((e) => {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak-${stamp}`;
  await fs.copyFile(file, backup);

  const wanted = new Map(Object.entries(vars));
  const out: string[] = [];
  const updated: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=.*$/);
    if (m && wanted.has(m[1])) {
      const v = wanted.get(m[1])!;
      wanted.delete(m[1]);
      if (v === "") continue; // blank clears back to process env
      out.push(`${m[1]}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
      updated.push(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of wanted) {
    if (v === "") continue;
    out.push(`${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
    updated.push(k);
  }
  await fs.writeFile(file, out.join("\n"), "utf8");
  return { updated, backup };
}
