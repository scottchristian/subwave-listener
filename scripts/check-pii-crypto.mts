// PII envelope crypto: enc/dec/idx round-trips and their failure modes.
//
// check-pii.mjs walks the source for leaks. This exercises the actual bytes,
// because the properties that matter here are all runtime and none of them are
// visible by reading the code:
//
//   - a wrong key must fail loudly, never return plaintext
//   - a tampered ciphertext must fail, not silently decrypt to garbage
//   - a plaintext row must still be readable (the live migration depends on it)
//   - the blind index must be case/whitespace-insensitive and deterministic
//
// Hermetic: the key comes from the environment, nothing touches disk.
//
// Run: npm run check:pii-crypto
process.env.PII_ENCRYPTION_KEY = process.env.PII_ENCRYPTION_KEY?.trim() || "a".repeat(64);
if (!/^[0-9a-f]{64}$/i.test(process.env.PII_ENCRYPTION_KEY)) {
  throw new Error("this suite needs a 64-char hex PII_ENCRYPTION_KEY");
}

const pii = await import("../lib/pii.ts");

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
function throws(fn: () => unknown, name: string) {
  try {
    fn();
    ok(false, name, "did not throw");
  } catch {
    ok(true, name);
  }
}

// ---- enc/dec round trip, including shapes that break naive concatenation ----
const cases: [string, string][] = [
  ["plain", "Cassandra Free"],
  ["one char", "x"],
  ["utf-8 multibyte", "Möði Ðjäzz Katrine"],
  ["emoji + surrogate pair", "wave 🎧🫧 join"],
  ["embedded quotes", 'say "cheers" now'],
  ["embedded backslash", "C:\\music\\tracks"],
  ["newline", "line one\nline two"],
  ["long", "a".repeat(5000)],
];
for (const [label, plain] of cases) {
  const enc = pii.enc(plain)!;
  ok(pii.isEncrypted(enc), `${label}: stored value is marked encrypted`);
  ok(pii.dec(enc) === plain, `${label}: round-trips`);
}
// Each encryption gets a fresh IV, so identical plaintext must not collide.
const a = pii.enc("same text")!;
const b = pii.enc("same text")!;
ok(a !== b, "identical plaintext encrypts differently (random IV)");
ok(pii.dec(a) === pii.dec(b), "both decrypt to the same plaintext");

// Empty inputs are absent, not encryptable-to-empty.
ok(pii.enc(null) === null, "enc(null) is null");
ok(pii.enc(undefined) === null, "enc(undefined) is null");
ok(pii.enc("") === null, "enc(\"\") is null");
ok(pii.dec(null) === null, "dec(null) is null");
ok(pii.dec("") === null, "dec(\"\") is null");
ok(!pii.isEncrypted(null) && !pii.isEncrypted("") && !pii.isIndexed(null) && !pii.isIndexed(""), "prefix predicates reject non-strings");
ok(pii.isIndexed("h1:zz") && !pii.isIndexed("e1:zz"), "index and envelope prefixes are distinguished");

// ---- the wrong key must fail, not fall back to plaintext ----
{
  const sealed = pii.enc("station password")!;
  const good = process.env.PII_ENCRYPTION_KEY!;
  process.env.PII_ENCRYPTION_KEY = "b".repeat(64);
  let leaked: string | null = null;
  try {
    leaked = pii.dec(sealed);
  } catch {
    leaked = null;
  }
  ok(leaked !== "station password", "wrong key never returns the plaintext");
  process.env.PII_ENCRYPTION_KEY = good;
}

// ---- tampering must be detected (GCM auth tag) ----
{
  const sealed = pii.enc("hello")!;
  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1] ^= 0x01; // flip one ciphertext bit
  let out: string | null = null;
  try {
    out = pii.dec("e1:" + raw.toString("base64"));
  } catch {
    out = null;
  }
  ok(out !== "hello", "tampered ciphertext does not decrypt to the original");
}
// A different IV (tag/ciphertext swap) must fail too.
{
  const one = Buffer.from(pii.enc("swap me")!.slice(3), "base64");
  const two = Buffer.from(pii.enc("swap me")!.slice(3), "base64");
  const mixed = Buffer.concat([one.subarray(0, 12), two.subarray(12)]);
  let out: string | null = null;
  try {
    out = pii.dec("e1:" + mixed.toString("base64"));
  } catch {
    out = null;
  }
  ok(out !== "swap me", "IV from one row + body from another does not decrypt");
}

// ---- migration path: rows written before encryption are still readable ----
ok(pii.dec("Cassandra Free") === "Cassandra Free", "pre-migration plaintext passes through");
ok(pii.dec("h1:abcdef") === "h1:abcdef", "a blind index in a name column passes through");
ok(!pii.isEncrypted("Cassandra Free"), "plaintext is not marked encrypted");

// ---- blind index: deterministic, normalized, opaque ----
const i1 = pii.idx("Listener@Example.com")!;
const i2 = pii.idx("  listener@example.com  ")!;
ok(i1 === i2, "index is case- and whitespace-insensitive");
ok(pii.idx("listener@example.com") === i2, "index is deterministic across calls");
ok(pii.isIndexed(i1), "index carries its prefix");
ok(!i1.includes("listener"), "index does not contain the address");
ok(!pii.isIndexed(pii.enc("listener@example.com")), "ciphertext is not mistaken for an index");
ok(i1 !== pii.enc("listener@example.com")!, "index and ciphertext are different shapes");
ok(pii.idx(null) === null, "idx(null) is null");
ok(pii.idx("") === null, "idx(\"\") is null");
ok(pii.idx("   ") === null, "idx(whitespace) is null");
// Different addresses must not collide, including ones differing only past the @.
ok(pii.idx("a@example.com") !== pii.idx("b@example.com"), "distinct addresses differ");
ok(pii.idx("a@example.com") !== pii.idx("a@example.co"), "distinct domains differ");

// ---- key validation: refuse rather than derive something weak ----
{
  const good = process.env.PII_ENCRYPTION_KEY!;
  process.env.PII_ENCRYPTION_KEY = "too-short";
  throws(() => pii.enc("x"), "a short key throws instead of encrypting");
  process.env.PII_ENCRYPTION_KEY = "";
  throws(() => pii.enc("x"), "an empty key throws instead of encrypting");
  process.env.PII_ENCRYPTION_KEY = good;
}
// base64 keys are accepted when they decode to 32 bytes.
{
  const good = process.env.PII_ENCRYPTION_KEY!;
  const asB64 = Buffer.from(Buffer.from(good, "hex")).toString("base64");
  process.env.PII_ENCRYPTION_KEY = asB64;
  const sealed = pii.enc("b64 key")!;
  ok(pii.dec(sealed) === "b64 key", "base64 key round-trips");
  process.env.PII_ENCRYPTION_KEY = good;
}

// ---- display helpers: what a browser is allowed to see ----
const nickname = pii.enc("Wave Rider")!;
const name = pii.enc("cassandra")!;
ok(pii.displayName({ nickname, name }) === "Wave Rider", "nickname outranks sign-in name");
ok(pii.displayName({ nickname: null, name }) === "cassandra", "falls back to the name");
ok(pii.displayName({}) === null, "no name at all is null");
ok(pii.displayName(null) === null, "a missing user is null");
ok(pii.displayName({ nickname: "", name }) === "cassandra", "empty nickname falls through");

const emailEnc = pii.enc("listener@example.com")!;
ok(pii.displayEmail({ emailEnc }) === "listener@example.com", "decrypted email displays");
ok(pii.displayEmail({ email: "legacy@example.com" }) === "legacy@example.com", "pre-migration plaintext email displays");
ok(pii.displayEmail({ email: "h1:deadbeef", emailEnc: null }) === null, "a bare blind index never displays");
ok(pii.displayEmail({ email: null, emailEnc: null }) === null, "no email at all is null");
ok(pii.displayEmail(undefined) === null, "a missing user is null");
// The index must not be mistaken for a displayable address even alongside ciphertext.
ok(pii.displayEmail({ email: pii.idx("x@example.com")!, emailEnc }) === "listener@example.com", "index present but encrypted email wins");

console.log(`  ${passed}/${passed + failed} pii-crypto assertions passed`);
if (failed > 0) process.exit(1);
