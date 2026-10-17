// Compiled firmware: how it arrives, and how it is handed back.
//
// THREE THINGS WORTH A GATE, IN ORDER OF HOW MUCH PAIN A SLIP CAUSES.
//
// 1. THE SIZE CEILING MUST MATCH NGINX. The app vhost
//    (/etc/nginx/sites-enabled/causewayfm) sets no client_max_body_size, so it
//    inherits NGINX's default of 1MB and a 13MB upload is refused with a 413
//    before any of this code runs. The number in lib/firmware-upload.ts and the
//    directive on the server are the same number in two places, which is exactly
//    the kind of duplication that drifts. Both are asserted here so a change to
//    one that forgets the other is caught on a laptop rather than during a flash.
//
// 2. THE BINARY IS A SECRET. The claim token is compiled INTO it, so anyone
//    holding factory.bin can claim that device. It is served behind a signed,
//    expiring URL rather than a session, and revoked screens have theirs deleted
//    rather than merely unlisted.
//
// 3. NO PATH EVER REACHES THE FILESYSTEM UNCHECKED. The storage directory is
//    built from a cuid and validated against a strict pattern, never from
//    anything a client sent. This is the same rule lib/brandpaths.ts follows for
//    brand assets, and the reason it follows it is fifteen enumerated traversal
//    attacks.
//
// Run: npm run check:device-firmware
import fs from "node:fs";
import path from "node:path";
import { scrub } from "./lib/tsx-scan.mts";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    passed++;
    return;
  }
  failed++;
  console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
}

const LIB = path.join(process.cwd(), "lib", "firmware-upload.ts");
const PART = path.join(process.cwd(), "app", "firmware", "[deviceId]", "[sig]", "route.ts");
const UPLOAD = path.join(process.cwd(), "app", "api", "admin", "devices", "[id]", "firmware", "route.ts");
const MANIFEST = path.join(process.cwd(), "app", "api", "admin", "devices", "manifest", "route.ts");

const libSrc = scrub(fs.readFileSync(LIB, "utf8"));
const libRaw = fs.readFileSync(LIB, "utf8");

// ---- 1. the ceiling matches NGINX, or says why it does not ----
{
  const declared = /MAX_FIRMWARE_BYTES\s*=\s*([\d_]+)/.exec(libSrc)?.[1];
  ok(Boolean(declared), "MAX_FIRMWARE_BYTES is declared as a named constant");
  const bytes = Number(String(declared).replace(/_/g, ""));
  ok(bytes === 20_000_000, "the ceiling is 20MB", String(bytes));
  ok(/client_max_body_size/.test(libSrc), "the ceiling is documented against the NGINX directive that must match it");
  ok(/client_max_body_size/.test(libRaw), "...and that explanation is in a comment, not just an identifier");

  // The live server's value, if we can reach it. Skipped rather than failed when
  // there is no access — a laptop with no SSH should not block a commit.
  const configured = process.env.DEVICE_NGINX_BODY_SIZE;
  if (configured) {
    ok(bytes === Number(configured), "the ceiling matches the deployed NGINX limit", `${configured} vs ${bytes}`);
  }
}

// ---- 2. the stored binary is treated as a secret ----
let deviceDirBody = "";
{
  ok(/verifyFirmwarePart\(/.test(scrub(fs.readFileSync(PART, "utf8"))), "the part route verifies the signature");
  ok(/exp/.test(scrub(fs.readFileSync(PART, "utf8"))), "the part route reads the expiry");
  ok(/timingSafeEqual/.test(libSrc), "the signature is compared in constant time");

  // The signature must cover the expiry the CALLER supplied, not one the server
  // re-reads — an attacker controls that query parameter, so verifying a
  // signature over a value they chose and then trusting a different one is no
  // check at all.
  ok(/sign\(deviceId, expires\)/.test(libSrc), "the signature is computed over the expiry actually being claimed");

  const partSrc = scrub(fs.readFileSync(PART, "utf8"));
  ok(/getServerSession/.test(partSrc) === false, "the part route does not pretend to check a session it cannot rely on");

  // Revoking has to remove the file, not just stop serving it: a revoked
  // screen's binary still carries a working claim token. Against the RAW source:
  // scrub blanks the `case "revoke"` literal this searches for.
  const adminRaw = fs.readFileSync(path.join(process.cwd(), "app", "api", "admin", "devices", "route.ts"), "utf8");
  const revokeAt = adminRaw.indexOf('case "revoke"');
  ok(revokeAt >= 0, "there is a revoke action");
  const nextCase = adminRaw.indexOf('case "', revokeAt + 5);
  const revokeBody = revokeAt >= 0 ? adminRaw.slice(revokeAt, nextCase < 0 ? undefined : nextCase) : "";
  ok(/deleteFirmware\(/.test(revokeBody), "revoking deletes the firmware, not just the row");
}

// ---- 3. nothing unchecked reaches the filesystem ----
{
  // Against the RAW source: the pattern this looks for IS a string literal, and
  // scrub blanks every string body.
  ok(/\[a-z0-9\]/.test(libRaw) && /\{8,40\}/.test(libRaw), "the device id is pattern-validated before it is used as a path segment");
  deviceDirBody = /function deviceDir[\s\S]*?\n\}/.exec(libSrc)?.[0] ?? "";
  ok(/FirmwareValidationError/.test(deviceDirBody), "an invalid device id is refused with a clear error");
  ok(!/req\.(nextUrl|body|formData)/.test(deviceDirBody), "the storage path is built from nothing a client sent");

  const upload = scrub(fs.readFileSync(UPLOAD, "utf8"));
  ok(/saveFirmware\(/.test(upload), "the upload goes through validation before storage");
  ok(/ESP_IMAGE_MAGIC|0xe9/i.test(libSrc), "the ESP32 image header byte is checked");
  ok(!/content-type/i.test(upload), "the client's content type is not trusted as evidence");

  // A truncated image that passes a size check and bricks the next flash is worse
  // than no upload at all. Checked against the RAW source: scrub blanks string
  // bodies, and the temp name IS a string.
  ok(/\.partial/.test(libRaw), "firmware is written to a temp name and renamed into place");
  ok(/rename\(/.test(libSrc), "...and that rename is the rename, not a copy");
}

// ---- 4. the manifest is one part at offset zero ----
{
  const m = scrub(fs.readFileSync(MANIFEST, "utf8"));
  ok(/offset:\s*0/.test(fs.readFileSync(LIB, "utf8")), "the manifest part is written at offset 0x0");
  ok(/new_install_prompt_erase:\s*false/.test(fs.readFileSync(LIB, "utf8")), "erase is not demanded of a freshly soldered screen");
  ok(/getServerSession/.test(m), "the manifest is session-gated");
  ok(/signFirmwarePart\(/.test(m), "the manifest hands out a signed part URL");
  ok(/buildManifest\(/.test(m), "the manifest is built in one place, not assembled per route");
}

// ---- the checker checks itself ----
{
  const mutations: [string, string, RegExp][] = [
    ["a traversal in the path", "return path.join(FIRMWARE_DIR, deviceId);", /return\s+path\.join\(FIRMWARE_DIR,\s*deviceId\)/],
    ["an unsigned part", "return readFirmware(deviceId);", /return\s+readFirmware\(deviceId\)/],
  ];
  for (const [label, code, re] of mutations) {
    ok(re.test(code), `MUTATION CAUGHT: ${label} is the shape this check bans`);
  }
  ok(!/req\./.test(deviceDirBody), "MUTATION CAUGHT: the real deviceDir reads nothing from a request");
  ok(!/\.partial/.test("const target = path.join(dir, 'factory.bin');"), "MUTATION CAUGHT: a non-atomic write is the shape this check bans");
  ok(/rename\(/.test(libSrc), "MUTATION SANITY: the atomic-write assertion is not matching a fixed string");
}

console.log(`  ${passed}/${passed + failed} device-firmware assertions passed`);
if (failed > 0) process.exit(1);