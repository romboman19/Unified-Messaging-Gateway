-- CreateEnum
CREATE TYPE "destination_type" AS ENUM ('webhook', 'email', 'telegram', 'internal_log');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'delivering', 'delivered', 'failed', 'dlq');

-- CreateEnum
CREATE TYPE "alert_status" AS ENUM ('firing', 'resolved');

-- CreateTable
CREATE TABLE "message_events" (
    "id" TEXT NOT NULL,
    "dedup_key" TEXT,
    "event_type" TEXT NOT NULL,
    "aggregate_id" TEXT,
    "channel_type" "channel_type",
    "account_id" TEXT,
    "endpoint_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "event_types" JSONB NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "field_selector" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destinations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "destination_type" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT,
    "secret_enc" TEXT,
    "config_json" JSONB NOT NULL DEFAULT '{}',
    "field_selector" JSONB NOT NULL DEFAULT '[]',
    "template_json" JSONB,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "routing_rule_destinations" (
    "rule_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,

    CONSTRAINT "routing_rule_destinations_pkey" PRIMARY KEY ("rule_id","destination_id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "destination_id" TEXT NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3),
    "last_response_code" INTEGER,
    "last_error" TEXT,
    "request_json" JSONB,
    "response_json" JSONB,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "message_id" TEXT,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rule_key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "alert_status" NOT NULL DEFAULT 'firing',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_events_dedup_key_key" ON "message_events"("dedup_key");

-- CreateIndex
CREATE INDEX "message_events_event_type_created_at_idx" ON "message_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "message_events_created_at_idx" ON "message_events"("created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_destination_id_created_at_idx" ON "webhook_deliveries"("destination_id", "created_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries"("event_id");

-- CreateIndex
CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- CreateIndex
CREATE INDEX "alerts_fingerprint_status_idx" ON "alerts"("fingerprint", "status");

-- AddForeignKey
ALTER TABLE "routing_rule_destinations" ADD CONSTRAINT "routing_rule_destinations_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "routing_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routing_rule_destinations" ADD CONSTRAINT "routing_rule_destinations_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "message_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

