import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InboundWebhooksController } from './inbound-webhooks.controller';
import { InboundQueueService, INBOUND_INGEST_QUEUE } from './inbound-queue.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: INBOUND_INGEST_QUEUE,
      defaultJobOptions: {
        // Ingestion is idempotent on the vendor message id, so retrying a
        // transient DB blip is safe.
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [InboundWebhooksController],
  providers: [InboundQueueService],
})
export class InboundWebhooksModule {}
