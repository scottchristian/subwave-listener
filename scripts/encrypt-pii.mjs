#!/usr/bin/env node
// One-shot PII encryption migration.
//
// Rewrites existing rows in place: User.email becomes a blind index with the
// real address in emailEnc, names/nicknames and donation supporter fields
// become AES-256-GCM ciphertext. Idempotent — rows already carrying the e1:/h1:
// markers are skipped, so a re-run is a no-op.
//
// Run it with the app STOPPED so nothing writes underneath it:
//   ssh root@$HOST 'cd $APP_DIR && pm2 stop $PM2_APP_NAME'
//   ssh root@$HOST 'cd $APP_DIR && export $(grep ^DATABASE_URL .env.local | xargs) && node scripts/encrypt-pii.mjs --confirm'
//   ssh root@$HOST 'cd $APP_DIR && pm2 start $PM2_APP_NAME'
//
// The host, directory and pm2 process name are this deployment's business — read
// them from .env.local (PM2_APP_NAME) rather than baking a station into a script.
//
// Takes a timestamped copy of the database before touching anything.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ENC_PREFIX = "e1:";
const IDX_PREFIX = "h1:";
const confirm = process.argv.includes("--confirm");

const raw = process.env.PII_ENCRYPTION_KEY;
if (!raw) {
  console.error("PII_ENCRYPTION_KEY is not set. Refusing to run — a wrong or missing key makes the data unreadable.");
  process.exit(1);
}
const KEY = /^[0-9a-f]{64}$/i.test(raw.trim())
  ? Buffer.from(raw.trim(), "hex")
  : Buffer.from(raw.trim(), "base64");
if (KEY.length !== 32) {
  console.error("PII_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  process.exit(1);
}

const enc = (plain) => {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
};
const idx = (email) => {
  if (!email) return null;
  const norm = String(email).trim().toLowerCase();
  if (!norm) return null;
  return IDX_PREFIX + crypto.createHmac("sha256", KEY).update(norm).digest("hex");
};
const isEnc = (v) => typeof v === "string" && v.startsWith(ENC_PREFIX);
const isIdx = (v) => typeof v === "string" && v.startsWith(IDX_PREFIX);

const url = process.env.DATABASE_URL || "";
const file = url.startsWith("file:") ? path.resolve(url.replace(/^file:/, "")) : "";
if (file && fs.existsSync(file)) {
  const backup = `${file}.bak-pii-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  console.log(`Backup written: ${backup}`);
} else {
  console.log("No local sqlite file found to back up (resolved:", file || "n/a", ")");
}

if (!confirm) {
  console.log("\nDry run. Re-run with --confirm to write. Nothing has been changed.");
  process.exit(0);
}

const prisma = new PrismaClient();
let users = 0;
let donations = 0;

try {
  const allUsers = await prisma.user.findMany();
  for (const u of allUsers) {
    const data = {};
    if (u.email && !isIdx(u.email)) {
      data.email = idx(u.email);
      data.emailEnc = enc(u.email);
    } else if (!u.emailEnc && u.email && isIdx(u.email)) {
      // Already indexed but never captured the plaintext (shouldn't happen).
      console.warn(`User ${u.id}: indexed email with no emailEnc — left as is.`);
    }
    if (u.name && !isEnc(u.name)) data.name = enc(u.name);
    if (u.nickname && !isEnc(u.nickname)) data.nickname = enc(u.nickname);
    if (Object.keys(data).length > 0) {
      await prisma.user.update({ where: { id: u.id }, data });
      users++;
    }
  }

  const allDonations = await prisma.donation.findMany();
  for (const d of allDonations) {
    const data = {};
    if (d.supporterEmail && !isEnc(d.supporterEmail)) {
      data.supporterEmail = enc(d.supporterEmail);
      data.supporterEmailIdx = idx(d.supporterEmail);
    }
    if (d.supporterName && !isEnc(d.supporterName)) data.supporterName = enc(d.supporterName);
    if (Object.keys(data).length > 0) {
      await prisma.donation.update({ where: { id: d.id }, data });
      donations++;
    }
  }

  // Verify: no row may still hold a plaintext address.
  const leftovers = await prisma.user.findMany({
    where: { NOT: { email: { startsWith: IDX_PREFIX } } },
    select: { id: true, email: true },
  });
  const plainNames = await prisma.user.findMany({
    where: { NOT: { name: { startsWith: ENC_PREFIX } }, name: { not: null } },
    select: { id: true },
  });

  console.log(`\nUsers encrypted:   ${users}`);
  console.log(`Donations encrypted: ${donations}`);
  if (leftovers.length) {
    console.error(`\nFAILED: ${leftovers.length} user(s) still hold a plaintext email.`);
    for (const l of leftovers) console.error(`  ${l.id}: ${l.email}`);
    process.exit(1);
  }
  if (plainNames.length) {
    console.error(`\nFAILED: ${plainNames.length} user(s) still hold a plaintext name.`);
    process.exit(1);
  }
  console.log("\nVerified: no plaintext email or name remains.");
} finally {
  await prisma.$disconnect();
}
