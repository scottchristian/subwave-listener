-- Baseline: the whole schema, in one migration.
--
-- WHY THIS REPLACES A HISTORY OF NINE. The history it replaces could never be
-- applied. 20260922105225_init created three tables — User, StreamSession,
-- Donation — out of thirteen, and of the rest only PushSubscription and
-- PresenceHeartbeat were created by migrations of their own. Eight tables were
-- never created at all, yet four later migrations referenced them, so the second
-- migration in the history failed on a clean database with "no such table:
-- SongLike", and `prisma migrate deploy` had never once completed. The gap was
-- not only missing tables: User.emailVerified and User.canUseSkills appear in no
-- migration, Donation.externalId and Donation.supporterName appear in no
-- migration, several unique constraints and query indexes appear in no
-- migration, and init created User.email as NOT NULL where the datamodel has it
-- nullable. That last one cannot be repaired by adding a migration, because
-- loosening a NOT NULL in SQLite means rebuilding the table.
--
-- A history that has never applied once, and cannot be patched into a valid
-- sequence, is not a history worth keeping. This is the standard remedy: squash
-- it to a single baseline that creates the current schema, so a new install
-- converges in one step on something that provably matches the datamodel.
--
-- THIS MIGRATION IS SQLITE ONLY. Postgres cannot replay DATETIME, so it is kept
-- in shape by `prisma db push` against the canonical schema instead, exactly as
-- before. Nothing about the Postgres path changes.
--
-- IF YOU ALREADY HAVE A DATABASE, DO NOT RUN THIS. Prisma refuses to migrate a
-- database that already has tables and no migration history, with P3005 and a
-- pointer to its baselining docs. That is Prisma being right: a station that
-- already holds donations and listeners must not have a baseline replayed over
-- it. Tell Prisma the schema is already there instead:
--
--     npx prisma migrate resolve --applied 20260924000000_baseline
--
-- A brand new database needs none of that. `npx prisma migrate deploy` against an
-- empty file is the whole procedure.
--
-- WHY FOREIGN KEYS ARE DECLARED INSIDE THE CREATE TABLE. `prisma migrate diff`
-- emits "ALTER TABLE ... ADD CONSTRAINT", which SQLite cannot execute against a
-- table that already exists.
--
-- Generated from the SQLite-flavoured datamodel (scripts/gen-schema.mjs sqlite),
-- not from the canonical Postgres one: generated from the Postgres schema, every
-- Float arrives as DOUBLE PRECISION, which SQLite has no concept of and which
-- then shows up as permanent drift.
--
-- Verified by migrating a clean database and diffing the result back against the
-- datamodel: no differences.

CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "emailEnc" TEXT,
    "emailVerified" DATETIME,
    "name" TEXT,
    "image" TEXT,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "canUseDj" BOOLEAN NOT NULL DEFAULT false,
    "canApprove" BOOLEAN NOT NULL DEFAULT false,
    "canUseSkills" BOOLEAN NOT NULL DEFAULT false,
    "hideLikeName" BOOLEAN NOT NULL DEFAULT false,
    "nickname" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);
CREATE TABLE IF NOT EXISTS "StreamSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" DATETIME,
    "durationSec" INTEGER,
    CONSTRAINT "StreamSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Donation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "supporterName" TEXT,
    "supporterEmail" TEXT NOT NULL,
    "supporterEmailIdx" TEXT,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "message" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalId" TEXT,
    CONSTRAINT "Donation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "SongRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "song" TEXT NOT NULL,
    "nameUsed" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SongRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "SongLike" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "title" TEXT,
    "artist" TEXT,
    "album" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SongLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "SongLinkCache" (
    "trackId" TEXT NOT NULL PRIMARY KEY,
    "spotifyUrl" TEXT,
    "appleMusicUrl" TEXT,
    "explicit" BOOLEAN,
    "resolvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "PresenceHeartbeat" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PresenceHeartbeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "SkillRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "skillLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "spoken" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "SkillRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "Session_sessionToken_key" ON "Session"("sessionToken");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_token_key" ON "VerificationToken"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");
CREATE INDEX IF NOT EXISTS "StreamSession_endTime_startTime_idx" ON "StreamSession"("endTime", "startTime");
CREATE INDEX IF NOT EXISTS "StreamSession_startTime_idx" ON "StreamSession"("startTime");
CREATE INDEX IF NOT EXISTS "StreamSession_userId_idx" ON "StreamSession"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "Donation_externalId_key" ON "Donation"("externalId");
CREATE INDEX IF NOT EXISTS "Donation_receivedAt_idx" ON "Donation"("receivedAt");
CREATE INDEX IF NOT EXISTS "Donation_userId_idx" ON "Donation"("userId");
CREATE INDEX IF NOT EXISTS "Donation_supporterEmailIdx_idx" ON "Donation"("supporterEmailIdx");
CREATE INDEX IF NOT EXISTS "SongRequest_userId_createdAt_idx" ON "SongRequest"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "SongLike_trackId_createdAt_idx" ON "SongLike"("trackId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "SongLike_userId_trackId_key" ON "SongLike"("userId", "trackId");
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");
CREATE INDEX IF NOT EXISTS "PresenceHeartbeat_lastSeen_idx" ON "PresenceHeartbeat"("lastSeen");
CREATE INDEX IF NOT EXISTS "SkillRun_status_queuedAt_idx" ON "SkillRun"("status", "queuedAt");
CREATE INDEX IF NOT EXISTS "SkillRun_userId_queuedAt_idx" ON "SkillRun"("userId", "queuedAt");
