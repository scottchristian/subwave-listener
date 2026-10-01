import crypto from "crypto";

// PII encryption at rest.
//
// Threat model: this protects a stolen database FILE. It does not protect a
// stolen server — the key lives in the app's env, so anyone who can read
// .env.local can decrypt. Keeping the key off the DB box is the other half.
//
// Email is special: ~12 call sites use `where: { email: <session email> }`,
// and the sign-in flow must FIND a user by the address Google gives us. So
// email is stored twice: `email` holds a deterministic HMAC blind index
// (opaque, unique, searchable by equality only) and `emailEnc` holds the
// AES-GCM ciphertext used for display. Every existing lookup keeps working
// unchanged — it just compares tokens instead of addresses.
//
// Names/nicknames/donation fields have no lookup requirement, so they are
// encrypted with a random IV and only ever decrypted on the way out.

const ENC_PREFIX = "e1:";
const IDX_PREFIX = "h1:";

function key(): Buffer {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "PII_ENCRYPTION_KEY is not set. Generate with `openssl rand -hex 32` and add it to .env.local."
    );
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  if (buf.length !== 32) {
    throw new Error("PII_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64).");
  }
  return buf;
}

/** AES-256-GCM, random IV. Output: e1:<b64(iv|tag|ciphertext)> */
export function enc(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  const k = key();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a stored value. Anything without the envelope prefix is returned
 * untouched — that is what makes the encrypt-migration safe to run against a
 * live database row by row, and it keeps a half-migrated table readable.
 */
export function dec(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined || stored === "") return null;
  const s = String(stored);
  if (!s.startsWith(ENC_PREFIX)) return s;
  const k = key();
  const raw = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Deterministic lookup token for an email. Equal addresses => equal tokens. */
export function idx(email: string | null | undefined): string | null {
  if (!email) return null;
  const norm = String(email).trim().toLowerCase();
  if (!norm) return null;
  return IDX_PREFIX + crypto.createHmac("sha256", key()).update(norm).digest("hex");
}

export const isEncrypted = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.startsWith(ENC_PREFIX);

export const isIndexed = (v: string | null | undefined): boolean =>
  typeof v === "string" && v.startsWith(IDX_PREFIX);

/** Display helpers — never leak ciphertext or the blind index to a browser. */
export function displayName(v: { nickname?: string | null; name?: string | null } | null | undefined): string | null {
  if (!v) return null;
  return dec(v.nickname) ?? dec(v.name) ?? null;
}

export function displayEmail(u: { emailEnc?: string | null; email?: string | null } | null | undefined): string | null {
  if (!u) return null;
  const enc2 = dec(u.emailEnc);
  if (enc2) return enc2;
  // Pre-migration rows: email is still plaintext, so it is safe to show.
  return u.email && !isIndexed(u.email) ? u.email : null;
}
