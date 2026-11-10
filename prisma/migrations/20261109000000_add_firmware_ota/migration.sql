-- Shared (fleet) firmware OTA: immutable releases, one live attempt per device.
--
-- WHY THIS IS ADDITIVE. Per-device USB flashing and its 20MB upload path stay
-- exactly as they are; this adds a second, separate path for one image shared by
-- every screen. Nothing here alters an existing column, so an older app build
-- pointed at this database keeps working and an older screen simply never sends
-- the optional OTA fields.
--
-- WHY SQLITE SYNTAX. Like the baseline and the two device migrations, this is
-- SQLite-only history; Postgres is kept in shape by 'prisma db push' against the
-- canonical schema (see deploy.sh). The columns are chosen so both engines agree:
-- no enums (phase/status are TEXT), no arrays, no generated columns.
--
-- WHY activeDeviceId IS A NULLABLE UNIQUE COLUMN. It holds the device id while an
-- attempt is live and is set to NULL when the attempt ends. Both engines treat
-- NULLs as distinct in a unique index, which gives "at most one live attempt per
-- device" as a CONSTRAINT rather than a read-then-insert race.
--
-- WHY NOTHING IS DELETED. A withdrawn release can still be pinned by an install
-- in flight, so artifacts and release rows are retained. Device deletion cascades
-- its own attempt history, but a release is Restrict: the database refuses to
-- orphan an attempt's release rather than silently dropping the audit.

-- AlterTable: OTA capability and the running image's identity.
ALTER TABLE "Device" ADD COLUMN "otaCapable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN "otaInstalledVersion" TEXT;
ALTER TABLE "Device" ADD COLUMN "otaInstalledSha" TEXT;
ALTER TABLE "Device" ADD COLUMN "otaInstalledSlot" TEXT;
ALTER TABLE "Device" ADD COLUMN "otaInstalledAt" DATETIME;

-- CreateTable
CREATE TABLE "FirmwareRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "descriptorProject" TEXT NOT NULL,
    "descriptorVersion" TEXT NOT NULL,
    "chipId" INTEGER NOT NULL,
    "minChipRev" INTEGER,
    "maxChipRev" INTEGER,
    "uploadedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" DATETIME,
    "withdrawnAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "FirmwareRelease_version_key" ON "FirmwareRelease"("version");
CREATE UNIQUE INDEX "FirmwareRelease_sha256_key" ON "FirmwareRelease"("sha256");
CREATE INDEX "FirmwareRelease_createdAt_idx" ON "FirmwareRelease"("createdAt");

-- CreateTable
CREATE TABLE "DeviceOtaAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'requested',
    "activeDeviceId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "installingAt" DATETIME,
    "rebootingAt" DATETIME,
    "finishedAt" DATETIME,
    "bootResult" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceOtaAttempt_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeviceOtaAttempt_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "FirmwareRelease" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceOtaAttempt_activeDeviceId_key" ON "DeviceOtaAttempt"("activeDeviceId");
CREATE UNIQUE INDEX "DeviceOtaAttempt_deviceId_requestId_key" ON "DeviceOtaAttempt"("deviceId", "requestId");
CREATE INDEX "DeviceOtaAttempt_deviceId_createdAt_idx" ON "DeviceOtaAttempt"("deviceId", "createdAt");
CREATE INDEX "DeviceOtaAttempt_releaseId_idx" ON "DeviceOtaAttempt"("releaseId");
CREATE INDEX "DeviceOtaAttempt_phase_idx" ON "DeviceOtaAttempt"("phase");
