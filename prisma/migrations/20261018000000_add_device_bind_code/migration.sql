-- Add bindCode and bindCodeExpires to Device for bind-code provisioning.
--
-- THIS MIGRATION IS SQLITE ONLY, like the baseline and 20261014000000_add_device.
-- Postgres is kept in shape by 'prisma db push' against the canonical schema.

-- AlterTable
ALTER TABLE "Device" ADD COLUMN "bindCode" TEXT;
ALTER TABLE "Device" ADD COLUMN "bindCodeExpires" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "Device_bindCode_key" ON "Device"("bindCode");
