-- Add the Device table: wall-mounted ESP32-P4 screens.
--
-- WHY THIS EXISTS. A screen is provisioned from the admin dashboard, flashed
-- through the browser, joins the station's WiFi, and then polls for now-playing
-- state. It is NOT a user and must never become one — it has its own row, its
-- own credential, and its own auth helper, and no path resolves a device request
-- to a User. Admin permissions on PROVISIONING are separate from device
-- permissions: an admin can create this row, and that authorises the creation
-- and nothing after it.
--
-- WHY deviceId IS NULLABLE. It is compiled into the firmware, and the row exists
-- before its binary does. That gap is deliberate: it is what makes "flash didn't
-- complete" a visible state in the admin panel instead of a half-registered
-- ghost that reports in forever. It is also why the column is a unique index
-- rather than the primary key — a row with no hardware yet still needs an id.
--
-- WHY createdById AND uploadedById ARE ON DELETE SET NULL. They are audit only
-- and are never read in an authorisation branch, so deleting a staff account must
-- NOT take their screens with it. Cascade here would quietly unregister a wall
-- display because someone left the team.
--
-- WHY EVERY ENUM-SHAPED COLUMN IS TEXT. This schema has to generate for SQLite as
-- well as Postgres, and Prisma enums are Postgres-only. Same reasoning as
-- SkillRun.status.
--
-- THIS MIGRATION IS SQLITE ONLY, like the baseline. Postgres cannot replay
-- DATETIME and is kept in shape by 'prisma db push' against the canonical
-- schema instead.
--
-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'jc8012p4a1',
    "claimToken" TEXT,
    "claimExpires" DATETIME,
    "tokenHash" TEXT,
    "rotatedAt" DATETIME,
    "prevTokenHash" TEXT,
    "prevTokenExpires" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'building',
    "buildStatus" TEXT NOT NULL DEFAULT 'building',
    "buildLog" TEXT,
    "firmwareSha" TEXT,
    "builtAt" DATETIME,
    "firmwareVer" TEXT,
    "lastSeenAt" DATETIME,
    "ip" TEXT,
    "rssi" INTEGER,
    "settingsRev" INTEGER NOT NULL DEFAULT 1,
    "appliedRev" INTEGER,
    "orientation" TEXT NOT NULL DEFAULT 'landscape',
    "themeMode" TEXT NOT NULL DEFAULT 'auto',
    "brightness" INTEGER NOT NULL DEFAULT 70,
    "idleMode" TEXT NOT NULL DEFAULT 'dim',
    "idleMin" INTEGER NOT NULL DEFAULT 15,
    "idlePct" INTEGER NOT NULL DEFAULT 20,
    "skipEnabled" TEXT NOT NULL DEFAULT '1',
    "rotateViews" TEXT NOT NULL DEFAULT '0',
    "timezone" TEXT NOT NULL DEFAULT '',
    "lat" REAL,
    "lon" REAL,
    "createdById" TEXT,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Device_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Device_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceId_key" ON "Device"("deviceId");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE INDEX "Device_lastSeenAt_idx" ON "Device"("lastSeenAt");

