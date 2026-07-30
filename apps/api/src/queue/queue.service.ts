import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class QueueService {
  constructor(@InjectQueue('message.send') private readonly sendQueue: Queue) {}

  async enqueueSend(messageId: string): Promise<void> {
    await this.sendQueue.add('send', { messageId }, { jobId: messageId });
  }
}
