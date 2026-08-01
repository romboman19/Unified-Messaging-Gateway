-- Provisioning lifecycle on Endpoint (TZ §1038).
-- Adds a typed state machine so the UI can drive QR/SMS link flows
-- independently from `enabled` (operational toggle).

-- CreateEnum
CREATE TYPE "registration_state" AS ENUM (
  'unpaired',         -- default; no sidecar attempt yet
  'qr_pending',       -- wizard requested a QR, waiting for sidecar to hand one back
  'qr_displayed',     -- QR fetched, polling link
  'sms_pending',      -- SMS/voice verification code requested
  'verifying',        -- code submitted, awaiting sidecar confirmation
  'linked',           -- sidecar confirmed the device/account
  'relink_needed',    -- sidecar has the account but our DB lost the link
  'failed'            -- last attempt errored; admin must retry
);

-- AlterTable
ALTER TABLE "endpoints"
  ADD COLUMN "registration_state" "registration_state" NOT NULL DEFAULT 'unpaired',
  ADD COLUMN "device_name"        TEXT,
  ADD COLUMN "uuid"               TEXT,
  ADD COLUMN "registered_at"      TIMESTAMP(3);

-- One Signal/UnoAPI account can be linked to at most one endpoint per UUID.
-- Postgres unique constraints allow multiple NULLs, so the partial unique
-- index is a defense-in-depth statement of intent.
CREATE UNIQUE INDEX "endpoints_uuid_unique" ON "endpoints"("uuid") WHERE "uuid" IS NOT NULL;

-- Wizard reconciliation scan: list endpoints by account + state cheaply.
CREATE INDEX "endpoints_account_id_registration_state_idx"
  ON "endpoints"("account_id", "registration_state");
