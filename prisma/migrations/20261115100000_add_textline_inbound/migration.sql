-- Proof that a phone texted the station before the station texts it a bind
-- code. The free Shared Line cannot open a conversation, so sign-up asks for
-- that text first and startLink only sends after a recent row matches.
--
-- No body is stored: the row answers "did this number text us recently", and
-- nothing else. providerId is unique so an at-least-once webhook redelivery
-- cannot add a second row; startLink prunes anything older than a day.
--
-- SQLite only, like the rest of the history; Postgres is kept in shape by
-- 'prisma db push' against the canonical schema.
CREATE TABLE "TextlineInbound" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "providerId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "TextlineInbound_providerId_key" ON "TextlineInbound"("providerId");
CREATE INDEX "TextlineInbound_phone_receivedAt_idx" ON "TextlineInbound"("phone", "receivedAt");
CREATE INDEX "TextlineInbound_receivedAt_idx" ON "TextlineInbound"("receivedAt");
