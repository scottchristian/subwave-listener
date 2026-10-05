// Branding asset resolution: which file a /brand/* URL serves.
//
// The security property is that a request parameter never reaches the
// filesystem unchecked, so the allowlist is asserted against traversal
// attempts, absolute paths, encoded separators and prototype keys — not just
// the happy paths. The resolution order (operator copy, then shipped default)
// is asserted against real files in a temp tree.
//
// Run: npm run check:brandpaths
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const bp = await import("../lib/brandpaths.ts");

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

// ---- allowlist: known assets only ----
ok(bp.isBrandAsset("logo.png"), "the logo is a known asset");
ok(bp.isBrandAsset("icons/icon-192.png"), "a nested icon path is a known asset");
ok(bp.isBrandAsset("favicon.ico"), "the favicon is a known asset");
ok(!bp.isBrandAsset(""), "an empty name is not an asset");
ok(!bp.isBrandAsset("logo.svg"), "an unknown extension is not an asset");
ok(!bp.isBrandAsset("logo.PNG"), "the allowlist is case-sensitive, as the URLs are");
ok(Object.values(bp.BRAND_ASSETS).every((d) => !!d && !d.includes("..")), "every default lives directly in the defaults dir");
// Every key must map to a distinct default, or two URLs would serve one file.
ok(new Set(Object.values(bp.BRAND_ASSETS)).size === Object.keys(bp.BRAND_ASSETS).length, "no two assets share a default file");

// ---- traversal and injection attempts are refused, not sanitised ----
const attacks = [
  "../../.env.local",
  "../.env.local",
  "logo.png/../../etc/passwd",
  "/etc/passwd",
  "/etc/passwd".replace("/etc/passwd", "..%2f..%2fetc%2fpasswd"),
  "logo.png\0.txt",
  "....//....//etc/passwd",
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "prototype",
  "logo.png/../../../root/.ssh/id_rsa",
  "./logo.png",
  "icons/../../.env.local",
];
for (const name of attacks) {
  ok(!bp.isBrandAsset(name), `refused: ${JSON.stringify(name)}`);
}
// Path separators must never appear in an allowed key: the route joins them.
for (const key of Object.keys(bp.BRAND_ASSETS)) {
  ok(!key.includes("..") && !key.startsWith("/") && !key.includes("\\"), `allowed key stays inside the dir: ${key}`);
  ok(!path.isAbsolute(path.join("/base", key)) || path.join("/base", key).startsWith("/base/"), `allowed key cannot escape: ${key}`);
}

// ---- prototype pollution cannot register a new asset ----
{
  const polluted = JSON.parse('{"__proto__": {"evil.png": "evil.png"}}');
  for (const key of Object.keys(polluted)) ok(!bp.isBrandAsset(key), `polluted key refused: ${key}`);
  ok(!bp.isBrandAsset("evil.png"), "a prototype-planted asset is not served");
}

// ---- content types ----
ok(bp.contentTypeFor("logo.png") === "image/png", "png type");
ok(bp.contentTypeFor("bg.jpg") === "image/jpeg", "jpeg type");
ok(bp.contentTypeFor("favicon.ico") === "image/x-icon", "ico type");
ok(bp.contentTypeFor("a.PNG") === "image/png", "extension match is case-insensitive");
ok(bp.contentTypeFor("a.svg") === "application/octet-stream", "an unlisted type falls back safely");
ok(bp.contentTypeFor("noextension") === "application/octet-stream", "a missing extension falls back safely");

// ---- resolution order, against a real temp tree ----
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subwave-brand-"));
const realBp = await import(`../lib/brandpaths.ts?brandtest=${Date.now()}`);
// The module resolves paths from cwd at load, so drive it through a chdir.
const prevCwd = process.cwd();
process.chdir(tmp);
const scoped = await import(`../lib/brandpaths.ts?scoped=${Date.now()}`);
await fs.mkdir(path.join(tmp, "public", "defaults", "icons"), { recursive: true });
await fs.mkdir(path.join(tmp, "data", "brand"), { recursive: true });
await fs.writeFile(path.join(tmp, "public", "defaults", "official_logo.png"), "PLACEHOLDER");
await fs.writeFile(path.join(tmp, "public", "defaults", "bg.jpg"), "PLACEHOLDER-BG");

{
  const r = await scoped.resolveBrandAsset("logo.png");
  ok(!!r && r.body.toString() === "PLACEHOLDER" && r.source === "default", "with no operator artwork, the placeholder is served");

  await fs.writeFile(path.join(tmp, "data", "brand", "logo.png"), "OPERATOR-LOGO");
  const r2 = await scoped.resolveBrandAsset("logo.png");
  ok(r2?.body.toString() === "OPERATOR-LOGO" && r2.source === "operator", "operator artwork takes precedence over the placeholder");

  ok((await scoped.hasOperatorBranding()) === true, "the station reports having its own artwork");
}
{
  // A zero-byte upload is not artwork: the placeholder must still win.
  await fs.writeFile(path.join(tmp, "data", "brand", "bg.jpg"), "");
  const r = await scoped.resolveBrandAsset("bg.jpg");
  ok(r?.body.toString() === "PLACEHOLDER-BG" && r.source === "default", "an empty upload falls back to the placeholder");
}
{
  // Both copies missing = a broken checkout, reported as null rather than empty.
  const r = await scoped.resolveBrandAsset("icons/icon-192.png");
  ok(r === null, "an asset with no copy at all resolves to null");
  ok(await scoped.resolveBrandAsset("not-an-asset.png") === null, "an unknown asset resolves to null before touching disk");
}
{
  // A traversal attempt must not reach a real file even though one exists there.
  await fs.writeFile(path.join(tmp, "secret.txt"), "SECRET");
  ok(await scoped.resolveBrandAsset("../secret.txt") === null, "a traversal attempt cannot read a file outside the brand dir");
}
process.chdir(prevCwd);
void realBp;
void bp;
await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});

console.log(`  ${passed}/${passed + failed} brandpaths assertions passed`);
if (failed > 0) process.exit(1);
