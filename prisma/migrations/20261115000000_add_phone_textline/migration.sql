-- The listener text line: a verified phone per account, the verification code
-- in flight, the transcript, per-show bells, and claimed reminder sends.
--
-- WHY ONE CASCADE SPINE. Every table hangs off PhoneContact with
-- ON DELETE CASCADE. Unlinking deletes that one row, and the database deletes
-- the transcript, bells and reminder claims in the same transaction. That is
-- the erasure the confirm dialog promises, and it must not depend on the
-- application remembering to run four deletes in the right order.
--
-- WHY providerId IS UNIQUE. Linq delivers webhooks at least once. A redelivery
-- must be a no-op, not a duplicate bubble, and the database is the cheapest
-- place to make that true.
--
-- WHY slotKey IS UNIQUE PER CONTACT. The reminder scheduler ticks every minute
-- and asks "does anything start in the next 15?" — the same showing is a
-- candidate for fifteen consecutive ticks. The unique claim is the send lock.
--
-- THIS MIGRATION IS SQLITE ONLY, like the rest: Postgres is kept in shape by
-- 'prisma db push' against the canonical schema.
--
-- CreateTable
CREATE TABLE "PhoneContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" DATETIME,
    "optedOutAt" DATETIME,
    CONSTRAINT "PhoneContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PhoneVerification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "PhoneVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TextMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TextMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "PhoneContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShowAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowAlert_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "PhoneContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShowReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "slotKey" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShowReminder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "PhoneContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PhoneContact_userId_key" ON "PhoneContact"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneContact_phone_key" ON "PhoneContact"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneVerification_userId_key" ON "PhoneVerification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TextMessage_providerId_key" ON "TextMessage"("providerId");

-- CreateIndex
CREATE INDEX "TextMessage_contactId_createdAt_idx" ON "TextMessage"("contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShowAlert_contactId_showId_key" ON "ShowAlert"("contactId", "showId");

-- CreateIndex
CREATE INDEX "ShowAlert_showId_idx" ON "ShowAlert"("showId");

-- CreateIndex
CREATE UNIQUE INDEX "ShowReminder_contactId_slotKey_key" ON "ShowReminder"("contactId", "slotKey");

-- CreateIndex
CREATE INDEX "ShowReminder_showId_idx" ON "ShowReminder"("showId");
