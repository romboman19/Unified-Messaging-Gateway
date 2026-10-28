-- CreateTable
CREATE TABLE "sms_part_buffer" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "inbound" JSONB NOT NULL,
    "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_part_buffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sms_part_buffer_endpoint_id_sender_arrived_at_idx" ON "sms_part_buffer"("endpoint_id", "sender", "arrived_at");
