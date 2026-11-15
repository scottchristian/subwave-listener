-- Texted requests forwarded to the booth, and the unauthorised-reply guard.
--
-- The host's request ledger is in memory, so this table is the durable record of
-- what a listener was told. deadlineAt is stamped when the host accepts, from
-- the admin-editable booth timeout.
--
-- repliedAt answers "did we already tell this unknown number to verify?", which
-- has no contact row to hang a TextMessage on.
--
-- SQLite only, like the rest of the history; Postgres is kept in shape by
-- 'prisma db push' against the canonical schema.
CREATE TABLE "TextlineRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "hostId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "waitSec" INTEGER,
    "waitNoticeSec" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "deadlineAt" DATETIME,
    "repliedAt" DATETIME,
    CONSTRAINT "TextlineRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "PhoneContact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TextlineRequest_hostId_key" ON "TextlineRequest"("hostId");
CREATE INDEX "TextlineRequest_status_createdAt_idx" ON "TextlineRequest"("status", "createdAt");
CREATE INDEX "TextlineRequest_contactId_createdAt_idx" ON "TextlineRequest"("contactId", "createdAt");

ALTER TABLE "TextlineInbound" ADD COLUMN "repliedAt" DATETIME;
