import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaClient, MessageStatus, Message } from '@prisma/client';
import { Inject, Logger } from '@nestjs/common';
import { MockAdapter } from '../adapters/mock.adapter';
import { EventsService } from '../events/events.service';
import { AlertsService } from '../alerts/alerts.service';

const MAX_SEND_ATTEMPTS = 3;

interface SendJobData {
  messageId: string;
}

@Processor('message.send')
export class MessageSendProcessor extends WorkerHost {
  private readonly logger = new Logger(MessageSendProcessor.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly mockAdapter: MockAdapter,
    private readonly eventsService: EventsService,
    private readonly alertsService: AlertsService,
  ) {
    super();
  }

  private async emitMessageEvent(
    type: string,
    message: Message,
    extraData: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.eventsService.emit({
        type,
        aggregateId: message.id,
        channel: message.channelType,
        accountId: message.accountId,
        endpointId: message.endpointId,
        data: {
          message: {
            id: message.id,
            direction: message.direction,
            channelType: message.channelType,
            accountId: message.accountId,
            endpointId: message.endpointId,
            status: message.status,
            externalId: message.externalId,
          },
          ...extraData,
        },
        dedupKey: `msg-${message.id}-${type}`,
      });
    } catch (err) {
      // Event emission must never break the send pipeline.
      this.logger.error(`Failed to emit ${type} for message ${message.id}: ${(err as Error).message}`);
    }
  }

  async process(job: Job<SendJobData, unknown>): Promise<void> {
    const { messageId } = job.data;
    const attemptNo = job.attemptsMade + 1;
    this.logger.log(`Processing send job ${job.id} for message ${messageId} attempt ${attemptNo}`);
    const prisma = this.prisma as any; // eslint-disable-line @typescript-eslint/no-explicit-any -- legacy untyped access kept for Message status history payload casts

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
      const updated = await prisma.message.update({
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
      const eventType = result.status === 'delivered' ? 'message.delivered' : 'message.sent';
      await this.emitMessageEvent(eventType, updated as Message, {});
    } catch (err) {
      const error = err as Error & { permanent?: boolean };
      // Permanent transport errors (invalid number, auth error, etc.) finish the
      // job without further retries per spec §10.4.
      if (error.permanent === true) {
        await prisma.messageAttempt.update({
          where: { id: attempt.id },
          data: {
            result: 'permanent_error',
            finishedAt: new Date(),
            errorJson: { message: error.message, permanent: true },
          } as any,
        });
        const failed = await prisma.message.update({
          where: { id: messageId },
          data: { status: MessageStatus.failed },
        });
        await prisma.messageStatusHistory.create({
          data: { messageId, status: MessageStatus.failed, source: 'worker', payload: { message: error.message, permanent: true } } as any,
        });
        await this.raiseSendFailureAlert(messageId, error.message);
        await this.emitMessageEvent('message.failed', failed as Message, { error: error.message });
        this.logger.warn(`Message ${messageId} failed permanently: ${error.message}`);
        return; // acknowledge the job — no BullMQ retry
      }

      const isRetryable = attemptNo < MAX_SEND_ATTEMPTS;
      await prisma.messageAttempt.update({
        where: { id: attempt.id },
        data: { result: isRetryable ? 'retryable_error' : 'final_error', finishedAt: new Date(), errorJson: { message: error.message } } as any,
      });
      if (!isRetryable) {
        const failed = await prisma.message.update({ where: { id: messageId }, data: { status: MessageStatus.failed } });
        await prisma.messageStatusHistory.create({
          data: { messageId, status: MessageStatus.failed, source: 'worker', payload: { message: error.message } } as any,
        });
        await this.raiseSendFailureAlert(messageId, error.message);
        await this.emitMessageEvent('message.failed', failed as Message, { error: error.message });
      }
      throw err;
    }
  }

  private async raiseSendFailureAlert(messageId: string, error: string): Promise<void> {
    try {
      await this.alertsService.raise({
        fingerprint: `send-failed:${messageId}`,
        ruleKey: 'message.send.final_failure',
        severity: 'warning',
        title: 'Повідомлення не доставлено',
        message: 'Вичерпано 3 спроби відправки повідомлення.',
        payload: { messageId, error },
      });
    } catch (err) {
      this.logger.error(`Failed to raise send-failed alert for ${messageId}: ${(err as Error).message}`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SendJobData>, err: Error) {
    this.logger.error(`Job ${job.id} failed after ${job.attemptsMade} attempts: ${err.message}`);
  }
}
