import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { QueueService } from '../queue/queue.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'message.send' })],
  controllers: [MessagesController],
  providers: [MessagesService, QueueService],
  exports: [MessagesService],
})
export class MessagesModule {}
