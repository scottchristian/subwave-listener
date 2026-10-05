// Reads the destination through its OWN Prisma client, generated from the
// provider-swapped schema. The canonical schema is never edited by hand —
// gen-schema.mjs rewrites only the datasource block — so the copy can never
// drift from what the app itself uses.
//
// This runs in the app process, so it must be a module the Next build can
// follow. The generated client lives outside node_modules/@prisma (Prisma 5.22
// has no --output flag) at a fixed, gitignored path.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DbProvider } from "./db-provider";

const APP_DIR = process.cwd();
export const SCHEMA_SRC = path.join(APP_DIR, "prisma", "schema.prisma");
const GEN_DIR = path.join(APP_DIR, "node_modules", ".subwave-clients");
const GEN_SCRIPT = path.join(APP_DIR, "scripts", "gen-schema.mjs");

/**
 * Prisma bakes the provider into the generated code, so a client for Postgres
 * cannot talk to SQLite and vice versa. We keep one generated client per
 * provider on disk and import it on demand, so a copy can hold both open at
 * once — which is the whole point, since verification compares the two.
 */
export function clientDirFor(provider: DbProvider): string {
  return path.join(GEN_DIR, provider);
}

function generateFor(provider: DbProvider): string {
  const dir = clientDirFor(provider);
  if (existsSync(path.join(dir, "index.js"))) return dir;
  if (!existsSync(GEN_SCRIPT)) {
    throw new Error(`Missing ${GEN_SCRIPT} — cannot generate the ${provider} schema.`);
  }
  mkdirSync(dir, { recursive: true });
  // A temp schema inside prisma/ so Prisma resolves the project's package.json
  // instead of trying to auto-install itself (it infers root from the file).
  const tmpSchema = path.join(APP_DIR, "prisma", `.gen-${provider}.prisma`);
  try {
    execFileSync(/* turbopackIgnore: true */ "node", [GEN_SCRIPT, provider, tmpSchema], { stdio: "pipe" });
    const raw = readFileSync(tmpSchema, "utf8");
    // Prisma 5.22 takes the output path in the generator block; the --output
    // flag only exists from Prisma 6.
    writeFileSync(
      tmpSchema,
      raw.replace(
        /(generator\s+client\s*\{\s*provider\s*=\s*"prisma-client-js")/,
        `$1\n  output   = ${JSON.stringify(dir)}`
      )
    );
    execFileSync("npx", ["prisma", "generate", "--schema", tmpSchema], { stdio: "pipe" });
  } finally {
    rmSync(tmpSchema, { force: true });
  }
  if (!existsSync(path.join(dir, "index.js"))) {
    throw new Error(`Prisma client generation for ${provider} produced no output.`);
  }
  return dir;
}

/** Parents first: every child references User, and Donation.userId is optional. */
export const MODEL_ORDER = [
  "user", "account", "session", "streamSession", "songRequest", "songLike",
  "pushSubscription", "presenceHeartbeat", "verificationToken",
  "setting", "songLinkCache", "donation", "skillRun",
] as const;

export type TableReport = {
  model: string;
  source: number;
  target: number;
  match: boolean;
};

export type CopyReport = {
  ok: boolean;
  direction: string;
  tables: TableReport[];
  total: number;
  failedReason?: string;
};

/** Content hash with Dates normalised, so a Date and its ISO form agree. */
export const hash = (rows: unknown[]) =>
  createHash("sha256")
    .update(JSON.stringify(rows, (k, v) => (v instanceof Date ? v.toISOString() : v)))
    .digest("hex");

/**
 * Open a Prisma client for one engine, generating it on demand if needed.
 *
 * Both engines' clients live in node_modules, generated at runtime by
 * `generateFor`, so their paths are not knowable at build time. Without the
 * ignore hint the bundler tries to resolve the computed path and fails the build.
 */
async function connectClient(provider: DbProvider, url: string): Promise<any> {
  const dir = generateFor(provider);
  const { PrismaClient } = await import(/* turbopackIgnore: true */ path.join(dir, "index.js"));
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Exported so the admin UI can name a step "verify" without a second algorithm. */
export type VerifyResult = {
  ok: boolean;
  direction: string;
  tables: TableReport[];
  total: number;
  failedReason?: string;
};

/**
 * Prove two databases hold identical data, without copying anything.
 *
 * This is the same per-table hash comparison `copyDatabase` runs inline, lifted
 * out so it can be called on its own — as a visible step in the move flow, and
 * again immediately before a cutover.
 *
 * That second call is the point. A copy verifies the moment it finishes, and
 * then the room is unguarded until someone switches: a listener can sign in, a
 * DJ can start a stream, and the target silently falls behind the source.
 * Re-running this at cutover closes that window, and means the switch no longer
 * depends on the browser asserting `verified: true`.
 */
export async function verifyCopy(opts: {
  sourceProvider: DbProvider;
  sourceUrl: string;
  targetProvider: DbProvider;
  targetUrl: string;
}): Promise<VerifyResult> {
  const direction = `${opts.sourceProvider} -> ${opts.targetProvider}`;
  const tables: TableReport[] = [];
  let src: any;
  let dst: any;
  try {
    src = await connectClient(opts.sourceProvider, opts.sourceUrl);
    dst = await connectClient(opts.targetProvider, opts.targetUrl);
    for (const model of MODEL_ORDER) {
      const a = sorted(await (src as any)[model].findMany());
      const b = sorted(await (dst as any)[model].findMany());
      const match = a.length === b.length && hash(a) === hash(b);
      tables.push({ model, source: a.length, target: b.length, match });
    }
  } catch (e: any) {
    return {
      ok: false, direction, tables,
      total: tables.reduce((s, t) => s + t.source, 0),
      failedReason: String(e?.message || e).trim().split("\n")[0],
    };
  } finally {
    await src?.$disconnect?.().catch(() => {});
    await dst?.$disconnect?.().catch(() => {});
  }
  const ok = tables.every((t) => t.match);
  return {
    ok, direction, tables,
    total: tables.reduce((s, t) => s + t.source, 0),
    ...(ok ? {} : { failedReason: "Verification failed — do not cut over." }),
  };
}

export function sorted(rows: any[]): any[] {
  const pk = Object.keys(rows[0] || { id: 1 })[0];
  const key = (r: any) => String(r[pk] ?? JSON.stringify(r));
  return [...rows].sort((x, y) => key(x).localeCompare(key(y)));
}

export type CopyOptions = {
  sourceProvider: DbProvider;
  sourceUrl: string;
  targetProvider: DbProvider;
  targetUrl: string;
  /** Create the destination tables when they are missing. */
  prepareTarget?: boolean;
  onProgress?: (msg: string) => void;
};

/**
 * Copy every table and prove the two match before anyone may cut over.
 *
 * Refuses to proceed against a populated target unless force is set: mixing a
 * partial copy into live rows leaves orphans that no count check would catch.
 * Never truncates the source, so the running database keeps serving
 * throughout.
 */
export async function copyDatabase(opts: CopyOptions): Promise<CopyReport> {
  const { sourceProvider, targetProvider } = opts;
  const log = opts.onProgress || (() => {});
  const tables: TableReport[] = [];

  if (sourceProvider === targetProvider) {
    return { ok: false, direction: "same", tables, total: 0, failedReason: "Source and target are the same provider." };
  }

  const src = await connectClient(sourceProvider, opts.sourceUrl);
  const dst = await connectClient(targetProvider, opts.targetUrl);

  try {
    // Check the destination BEFORE touching it. Running `db push` against a
    // populated database fails inside Prisma with an opaque message about
    // columns and defaults; refusing here says what is actually wrong.
    const existing = await dst.user.count().catch(() => null);
    if (existing !== null && existing > 0) {
      return {
        ok: false, direction: `${sourceProvider} -> ${targetProvider}`, tables, total: 0,
        failedReason: `The destination already holds ${existing} user row(s). Refusing to mix copies — that would leave orphaned records. Clear the destination, or revert to an empty one.`,
      };
    }
    if (existing === null) {
      if (!opts.prepareTarget) {
        return {
          ok: false, direction: `${sourceProvider} -> ${targetProvider}`, tables, total: 0,
          failedReason: "The destination has no tables yet. Run the copy with schema creation enabled.",
        };
      }
      log("Creating the destination schema…");
      await prepareTargetSchema(targetProvider, opts.targetUrl);
    }

    for (const model of MODEL_ORDER) {
      const rows = await (src as any)[model].findMany();
      if (rows.length) {
        // Batched: the largest table here is StreamSession, and one statement
        // with thousands of binds will exceed Postgres' parameter limit.
        for (let i = 0; i < rows.length; i += 2000) {
          await (dst as any)[model].createMany({ data: rows.slice(i, i + 2000) });
        }
      }
      const back = await (dst as any)[model].findMany();
      const a = sorted(rows);
      const b = sorted(back);
      const match = a.length === b.length && hash(a) === hash(b);
      tables.push({ model, source: rows.length, target: back.length, match });
      log(`${model}: ${rows.length} rows ${match ? "verified" : "MISMATCH"}`);
    }
  } catch (e: any) {
    return {
      ok: false, direction: `${sourceProvider} -> ${targetProvider}`, tables, total: 0,
      failedReason: String(e?.message || e).trim().split("\n")[0],
    };
  } finally {
    await src.$disconnect().catch(() => {});
    await dst.$disconnect().catch(() => {});
  }

  const ok = tables.every((t) => t.match);
  return {
    ok,
    direction: `${sourceProvider} -> ${targetProvider}`,
    tables,
    total: tables.reduce((s, t) => s + t.source, 0),
    ...(ok ? {} : { failedReason: "Verification failed — do not cut over." }),
  };
}

/**
 * Create the destination schema as the app role, so it OWNS what it creates.
 * That ownership is what lets a later migration ALTER and DROP without
 * re-granting; table-level privileges never cover those.
 */
export async function prepareTargetSchema(provider: DbProvider, url: string): Promise<void> {
  const tmpSchema = path.join(APP_DIR, "prisma", `.prep-${provider}.prisma`);
  try {
    execFileSync(/* turbopackIgnore: true */ "node", [GEN_SCRIPT, provider, tmpSchema], { stdio: "pipe" });
    execFileSync(
      /* turbopackIgnore: true */ "npx",
      ["prisma", "db", "push", "--schema", tmpSchema, "--skip-generate", "--accept-data-loss"],
      { stdio: "pipe", env: { ...process.env, DATABASE_URL: url } }
    );
  } catch (e: any) {
    const out = `${e?.stdout || ""}${e?.stderr || ""}`.trim();
    throw new Error(out.split("\n").filter(Boolean).slice(-3).join(" · ") || String(e?.message || e));
  } finally {
    rmSync(tmpSchema, { force: true });
  }
}
