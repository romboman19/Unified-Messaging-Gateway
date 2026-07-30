import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

export const WEBHOOK_DELIVER_QUEUE = 'webhook.deliver';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('message.send') private readonly sendQueue: Queue,
    @InjectQueue(WEBHOOK_DELIVER_QUEUE) private readonly webhookQueue: Queue,
  ) {}

  async enqueueSend(messageId: string, jobIdSuffix?: string): Promise<void> {
    const jobId = jobIdSuffix ? `${messageId}-${jobIdSuffix}` : messageId;
    await this.sendQueue.add('send', { messageId }, { jobId });
  }

  async removeSend(messageId: string): Promise<void> {
    const job = await this.sendQueue.getJob(messageId);
    if (job) await job.remove();
  }

  async enqueueWebhookDelivery(deliveryId: string): Promise<void> {
    await this.webhookQueue.add('deliver', { deliveryId }, { jobId: deliveryId });
  }
}
