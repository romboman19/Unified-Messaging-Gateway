import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { QueueService, WEBHOOK_DELIVER_QUEUE } from '../queue/queue.service';

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
  controllers: [MessagesController],
  providers: [MessagesService, QueueService],
  exports: [MessagesService],
})
export class MessagesModule {}
