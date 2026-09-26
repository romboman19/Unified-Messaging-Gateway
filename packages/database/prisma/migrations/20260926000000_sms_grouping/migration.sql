ALTER TABLE "messages" ADD COLUMN "sms_group_key" TEXT,
  ADD COLUMN "sms_group_due_at" TIMESTAMP(3),
  ADD COLUMN "sms_group_expires_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "messages_sms_group_key_key" ON "messages"("sms_group_key");
CREATE INDEX "messages_sms_group_due_at_idx" ON "messages"("sms_group_due_at");

CREATE TABLE "sms_parts" (
  "id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "endpoint_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "position" INTEGER NOT NULL,
  CONSTRAINT "sms_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sms_parts_message_id_fkey" FOREIGN KEY ("message_id")
    REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sms_parts_endpoint_id_source_key_key" ON "sms_parts"("endpoint_id", "source_key");
CREATE INDEX "sms_parts_message_id_position_idx" ON "sms_parts"("message_id", "position");
