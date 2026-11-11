// Seeded mutation fuzz for the ESP app-image validator.
//
// WHY THIS EXISTS.
// parseEspAppImage is the only thing between an operator's upload and the device's
// boot slot. check-firmware-ota.mts proves the named malformed shapes are refused;
// this proves the property behind them: for ANY bytes, the parser either returns a
// self-consistent image or throws a bounded OtaError. It never hangs, never throws
// a bare TypeError, and never accepts bytes it cannot hash.
//
// The mutations are seeded, so a failure reproduces on the next run. There is no
// database and no filesystem: the corpus is built in memory.
//
// Run: npm run check:firmware-image-fuzz

import { createHash } from "node:crypto";

// lib/firmware-ota.ts pulls in Prisma at module load. Nothing here queries it, but
// the client's constructor wants a datasource, so give it a harmless one.
process.env.DATABASE_URL ||= "file:./data/fuzz-unused.db";
process.env.DB_PROVIDER ||= "sqlite";

const ota = await import("../lib/firmware-ota.ts");

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.error(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const HEADER = 24;
const DESC_MAGIC = 0xabcd5432;
const KNOWN_CODES = new Set([
  "truncated",
  "oversized",
  "not_app_image",
  "bad_header",
  "bad_checksum",
  "bad_hash",
  "trailing_data",
  "bad_descriptor",
  "wrong_chip",
  "wrong_project",
]);

function put(buf: Buffer, at: number, text: string, len: number) {
  buf.fill(0, at, at + len);
  buf.write(text.slice(0, len - 1), at, "latin1");
}

function buildImage(o: { version?: string; project?: string; dataLen?: number; hash?: boolean; chipId?: number } = {}): Buffer {
  const dataLen = o.dataLen ?? 280;
  if (dataLen % 4 !== 0 || dataLen < 256) throw new Error("bad fuzz image geometry");
  const header = Buffer.alloc(HEADER);
  header[0] = 0xe9;
  header[1] = 1;
  header.writeUInt16LE(o.chipId ?? 18, 0x0c);
  header.writeUInt16LE(0, 0x0f);
  header.writeUInt16LE(300, 0x11);
  header[0x17] = (o.hash ?? true) ? 1 : 0;

  const data = Buffer.alloc(dataLen, 0xa5);
  data.writeUInt32LE(DESC_MAGIC, 0);
  put(data, 16, o.version ?? "1.0.0", 32);
  put(data, 48, o.project ?? "subwave-screen", 32);
  put(data, 112, "v5.5.4", 32);

  const segHeader = Buffer.alloc(8);
  segHeader.writeUInt32LE(0x40000000, 0);
  segHeader.writeUInt32LE(data.length, 4);

  const segmentsEnd = HEADER + 8 + data.length;
  const pad = ((segmentsEnd + 1 + 15) & ~15) - segmentsEnd;
  const tail = Buffer.alloc(pad);
  let checksum = 0xef;
  for (const byte of data) checksum ^= byte;
  tail[pad - 1] = checksum & 0xff;

  const body = Buffer.concat([header, segHeader, data, tail]);
  return o.hash === false ? body : Buffer.concat([body, createHash("sha256").update(body).digest()]);
}

const seeds: Buffer[] = [
  buildImage({ version: "1.0.0" }),
  buildImage({ version: "1.15.7", dataLen: 288 }),
  buildImage({ version: "2.0.0", project: "causewayfm.subwave-screen", dataLen: 272 }),
  buildImage({ version: "1.0.0", hash: false }),
];

// ---------------------------------------------------------------------------
// Seeded generator — one PRNG so every run is the same run.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x51b0a7e);
const int = (n: number) => Math.floor(rand() * n);
const pick = <T,>(items: T[]): T => items[int(items.length)];

// ---------------------------------------------------------------------------
// Invariants applied to every outcome
// ---------------------------------------------------------------------------

const violations: string[] = [];

function checkOutcome(label: string, bytes: Buffer) {
  let parsed: ReturnType<typeof ota.parseEspAppImage> | null = null;
  let thrown: unknown = null;
  try {
    parsed = ota.parseEspAppImage(bytes);
  } catch (e) {
    thrown = e;
  }

  if (thrown !== null) {
    const code = (thrown as { code?: unknown })?.code;
    if (typeof code !== "string" || !KNOWN_CODES.has(code)) {
      violations.push(`${label}: threw ${String(code ?? thrown)}`);
    }
    if (!(thrown instanceof Error)) violations.push(`${label}: threw a non-Error`);
    return;
  }

  if (parsed === null) {
    violations.push(`${label}: returned null instead of throwing`);
    return;
  }
  if (parsed.sizeBytes !== bytes.length) violations.push(`${label}: size ${parsed.sizeBytes} != ${bytes.length}`);
  if (parsed.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    violations.push(`${label}: sha256 does not cover the bytes`);
  }
  if (!/^\d+\.\d+\.\d+/.test(parsed.descriptor.version)) violations.push(`${label}: unorderable version accepted`);
  if (!ota.OTA_PROJECTS.includes(parsed.descriptor.project as never)) {
    violations.push(`${label}: foreign project accepted`);
  }
  if (parsed.chipId !== ota.ESP32P4_CHIP_ID) violations.push(`${label}: wrong chip accepted`);
}

// ---------------------------------------------------------------------------
// 1. Seeds parse, and the parser is deterministic on them.
// ---------------------------------------------------------------------------
{
  for (const [i, seed] of seeds.entries()) {
    checkOutcome(`seed${i}`, seed);
    const twice = ota.parseEspAppImage(seed);
    ok(twice.sizeBytes === seed.length, `seed ${i} parses at its real size`);
    ok(
      twice.sha256 === ota.parseEspAppImage(Buffer.from(seed)).sha256,
      `seed ${i} parses identically on a second call`,
    );
  }
  ok(violations.length === 0, "the valid corpus parses consistently", violations.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// 2. Every single-byte change to a hash-appended image is refused.
//
// SHA-256 covers the body; changing any byte either breaks the checksum walk or
// the appended digest. A single accepted flip would mean the digest is not
// actually being checked.
// ---------------------------------------------------------------------------
{
  const accepted: string[] = [];
  let cases = 0;
  for (const seed of seeds.filter((s) => s[0x17] === 1)) {
    for (let at = 0; at < seed.length; at++) {
      for (const mask of [0x01, 0x80]) {
        const mutated = Buffer.from(seed);
        mutated[at] ^= mask;
        cases++;
        try {
          ota.parseEspAppImage(mutated);
          accepted.push(`offset ${at} ^ ${mask}`);
        } catch {
          // expected
        }
      }
    }
  }
  ok(cases > 1000, "the single-byte sweep is meaningful", `${cases} cases`);
  ok(accepted.length === 0, "no single-byte change to a hashed image is accepted", accepted.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// 3. Every truncation is refused, and every appended byte is noticed.
// ---------------------------------------------------------------------------
{
  const seed = seeds[0]!;
  const accepted: number[] = [];
  for (let len = 0; len < seed.length; len++) {
    try {
      ota.parseEspAppImage(seed.subarray(0, len));
      accepted.push(len);
    } catch {
      // expected
    }
  }
  ok(accepted.length === 0, "every truncation is refused", accepted.slice(0, 5).join(","));

  const noHash = seeds[3]!;
  const grown = Buffer.concat([noHash, Buffer.from([0, 1, 2])]);
  let code = "no-throw";
  try {
    ota.parseEspAppImage(grown);
  } catch (e) {
    code = (e as { code?: string })?.code ?? "unknown";
  }
  ok(code === "trailing_data", "bytes after a valid image are refused, not ignored", code);
}

// ---------------------------------------------------------------------------
// 4. Random structural mutations: 2,000 cases, one invariant.
// ---------------------------------------------------------------------------
{
  const before = violations.length;
  const acceptedMutations: string[] = [];

  for (let i = 0; i < 2000; i++) {
    const seed = pick(seeds);
    const kind = int(6);
    let mutated: Buffer;
    let label: string;

    if (kind === 0) {
      // Flip 1–5 random bits.
      mutated = Buffer.from(seed);
      const flips = 1 + int(5);
      for (let f = 0; f < flips; f++) {
        const at = int(mutated.length);
        mutated[at] ^= 1 << int(8);
      }
      label = `bits#${i}`;
    } else if (kind === 1) {
      // Overwrite a span with random bytes.
      mutated = Buffer.from(seed);
      const at = int(mutated.length);
      const len = Math.min(1 + int(24), mutated.length - at);
      for (let j = 0; j < len; j++) mutated[at + j] = int(256);
      label = `span#${i}`;
    } else if (kind === 2) {
      // Truncate anywhere.
      mutated = seed.subarray(0, int(seed.length + 1));
      label = `cut#${i}`;
    } else if (kind === 3) {
      // Append junk.
      const junk = Buffer.alloc(1 + int(64));
      for (let j = 0; j < junk.length; j++) junk[j] = int(256);
      mutated = Buffer.concat([seed, junk]);
      label = `tail#${i}`;
    } else if (kind === 4) {
      // Fully random bytes behind a valid magic, so the header walk is exercised.
      const len = 320 + int(1200);
      mutated = Buffer.alloc(len);
      for (let j = 0; j < len; j++) mutated[j] = int(256);
      mutated[0] = 0xe9;
      label = `random#${i}`;
    } else {
      // A random header field, body intact.
      mutated = Buffer.from(seed);
      const at = pick([0, 1, 0x0c, 0x0d, 0x0f, 0x11, 0x17]);
      mutated[at] = int(256);
      label = `field${at}#${i}`;
    }

    let accepted = false;
    try {
      ota.parseEspAppImage(mutated);
      accepted = true;
    } catch {
      // expected
    }
    checkOutcome(label, mutated);

    // A mutation that is still a valid image is allowed only if it changed no
    // covered byte — which none of these do. Tie the two facts together so an
    // "accepted but inconsistent" case cannot hide.
    if (accepted) {
      try {
        const parsed = ota.parseEspAppImage(mutated);
        if (parsed.sha256 !== createHash("sha256").update(mutated).digest("hex")) acceptedMutations.push(label);
      } catch {
        acceptedMutations.push(label);
      }
    }
  }

  ok(violations.length === before, "2,000 structural mutations produce only bounded refusals", violations.slice(before, before + 3).join(" | "));
  ok(acceptedMutations.length === 0, "nothing is accepted with a digest that does not match its bytes", acceptedMutations.slice(0, 3).join(" | "));
}

// ---------------------------------------------------------------------------
// 5. Oversize is refused before any walk, at the exact slot boundary.
// ---------------------------------------------------------------------------
{
  const atLimit = Buffer.alloc(ota.APP_SLOT_BYTES, 0);
  atLimit[0] = 0xe9;
  let code = "no-throw";
  try {
    ota.parseEspAppImage(atLimit);
  } catch (e) {
    code = (e as { code?: string })?.code ?? "unknown";
  }
  ok(code !== "oversized", "exactly one slot's bytes are not oversized", code);
  ok(code === "bad_header" || code === "truncated" || code === "not_app_image" || code === "bad_checksum",
    "and are still refused for being a malformed image", code);

  const over = Buffer.alloc(ota.APP_SLOT_BYTES + 1, 0);
  over[0] = 0xe9;
  code = "no-throw";
  try {
    ota.parseEspAppImage(over);
  } catch (e) {
    code = (e as { code?: string })?.code ?? "unknown";
  }
  ok(code === "oversized", "one byte over the slot is refused as oversized", code);
}

// ---------------------------------------------------------------------------
// 6. Inputs arrive as Buffers from fs.readFile and as parsers call it; a few
//    non-Buffer shapes must fail closed rather than crash unpredictably.
// ---------------------------------------------------------------------------
{
  for (const value of [new Uint8Array(400).fill(0), Buffer.from("x".repeat(400))]) {
    let code = "no-throw";
    try {
      ota.parseEspAppImage(value as never);
    } catch (e) {
      code = (e as { code?: string })?.code ?? "unknown";
    }
    ok(code !== "no-throw" && KNOWN_CODES.has(code), `a ${value.constructor.name} of non-image bytes is refused`, code);
  }
}

console.log(`  ${passed}/${passed + failed} image-fuzz assertions passed`);
if (failed > 0) process.exit(1);
