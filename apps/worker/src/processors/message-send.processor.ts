import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaClient, MessageStatus } from '@prisma/client';
import { Inject, Logger } from '@nestjs/common';
import { MockAdapter } from '../adapters/mock.adapter';

interface SendJobData {
  messageId: string;
}

@Processor('message.send')
export class MessageSendProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageSendProcessor.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly mockAdapter: MockAdapter,
  ) {
    super();
  }

  async process(job: Job<SendJobData, unknown>): Promise<void> {
    const { messageId } = job.data;
    const attemptNo = job.attemptsMade + 1;
    this.logger.log(`Processing send job ${job.id} for message ${messageId} attempt ${attemptNo}`);
    const prisma = this.prisma as any;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    await prisma.message.update({
      where: { id: messageId },
      data: { status: MessageStatus.dispatching },
    });
    await prisma.messageStatusHistory.create({
      data: { messageId, status: MessageStatus.dispatching, source: 'worker', payload: { jobId: job.id, attemptNo } },
    });

    const attempt = await prisma.messageAttempt.create({
      data: { messageId, attemptNo, result: 'pending' },
    });

    try {
      const result = await this.mockAdapter.send(message);
      const nextStatus = result.status === 'delivered' ? MessageStatus.delivered : MessageStatus.sent;
      await prisma.message.update({
        where: { id: messageId },
        data: { status: nextStatus, externalId: result.externalId ?? null },
      });
      await prisma.messageStatusHistory.create({
        data: { messageId, status: nextStatus, source: 'mock_adapter', payload: result.raw } as any,
      });
      await prisma.messageAttempt.update({
        where: { id: attempt.id },
        data: { result: result.status, finishedAt: new Date() },
      });
    } catch (err) {
      const error = err as Error;
      const isRetryable = attemptNo < 3;
      await prisma.messageAttempt.update({
        where: { id: attempt.id },
        data: { result: isRetryable ? 'retryable_error' : 'final_error', finishedAt: new Date(), errorJson: { message: error.message } } as any,
      });
      if (!isRetryable) {
        await prisma.message.update({ where: { id: messageId }, data: { status: MessageStatus.failed } });
        await prisma.messageStatusHistory.create({
          data: { messageId, status: MessageStatus.failed, source: 'worker', payload: { message: error.message } } as any,
        });
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendJobData>, err: Error) {
    this.logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
