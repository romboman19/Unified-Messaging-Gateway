import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueService, WEBHOOK_DELIVER_QUEUE } from './queue.service';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'message.send' },
      {
        name: WEBHOOK_DELIVER_QUEUE,
        defaultJobOptions: {
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      },
    ),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
