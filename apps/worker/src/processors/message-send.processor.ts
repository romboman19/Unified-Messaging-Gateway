import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaClient, MessageStatus, Message } from '@prisma/client';
import { Inject, Logger } from '@nestjs/common';
import type {
  AccountConfig,
  CanonicalContent,
  CanonicalMessageType,
  CanonicalOutbound,
  ChannelAdapter,
  EndpointConfig,
  SendResult,
} from '@umg/channel-sdk';
import { AdaptersRegistry } from '../adapters/adapters.registry';
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
    private readonly adapters: AdaptersRegistry,
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
      this.logger.error(`Failed to emit ${type} for message ${message.id}: ${(err as Error).message}`);
    }
  }

  async process(job: Job<SendJobData, unknown>): Promise<void> {
    const { messageId } = job.data;
    const attemptNo = job.attemptsMade + 1;
    this.logger.log(`Processing send job ${job.id} for message ${messageId} attempt ${attemptNo}`);
    const prisma = this.prisma as any;

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: { endpoint: true },
    });
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
      // Resolve adapter via the registry, keyed by `transport_accounts.adapter`
      // per TZ `adapters.md` §5 and §1 rules.
      const account = await prisma.transportAccount.findUnique({ where: { id: message.accountId } });
      if (!account) {
        throw new Error(`TransportAccount ${message.accountId} not found for message ${messageId}`);
      }

      let adapterName: string = account.adapter;
      let adapter: ChannelAdapter;
      try {
        adapter = this.adapters.get(adapterName);
      } catch (e: any) {
        // Unregistered adapter names fall back to mock with a clear log.
        // The UI-side validation already rejects these at send-time
        // (see commit `fb6d179`); this is a safety net for stale data.
        this.logger.error(`Unknown adapter "${adapterName}" on account ${account.id}: ${e.message}; falling back to mock`);
        adapterName = 'mock';
        adapter = this.adapters.get(adapterName);
      }

      const endpointConfig: EndpointConfig = {
        id: message.endpointId,
        externalId: (message as any).endpoint?.externalId ?? '',
        phoneE164: (message as any).endpoint?.phoneE164 ?? null,
        label: (message as any).endpoint?.label ?? '',
        configJson: ((message as any).endpoint?.configJson ?? {}) as Record<string, unknown>,
      };

      // Backend stores encrypted config JSON, not yet decrypted by core.
      // For now we treat `account.encryptedConfig` as already-decrypted.
      // Production hardening (TZ §8.3): add AES-256-GCM here once MASTER_KEY
      // is wired up.
      const accountConfig: AccountConfig = {
        id: account.id,
        adapter: account.adapter,
        configJson: (account.encryptedConfig ?? {}) as Record<string, unknown>,
      };

      // Canonical outbound: read recipient from `toJson` (Prisma JSON column)
      // and body text from `contentJson`. The Prisma client exposes these
      // as `toJson` / `contentJson` of type `Prisma.JsonValue`.
      const toJson = (message as any).toJson as Record<string, unknown> | null;
      const contentJson = (message as any).contentJson as Record<string, unknown> | null;
      const toRaw = typeof toJson?.['raw'] === 'string' ? (toJson['raw'] as string) : '';
      const toE164 = typeof toJson?.['e164'] === 'string' ? (toJson['e164'] as string) : null;
      const bodyText = typeof contentJson?.['text'] === 'string' ? (contentJson['text'] as string) : '';

      const outbound: CanonicalOutbound = {
        messageId: message.id,
        idempotencyKey: message.id,
        to: [
          {
            raw: toRaw,
            e164: toE164,
            display: toRaw || null,
          },
        ],
        type: ((message as any).type ?? 'text') as CanonicalMessageType,
        content: { text: bodyText } as CanonicalContent,
      };

      const result: SendResult = await adapter.send(outbound, endpointConfig, accountConfig);

      if (!result.accepted) {
        const retryable = !!result.error?.retryable;
        if (!retryable) {
          await prisma.messageAttempt.update({
            where: { id: attempt.id },
            data: { result: 'permanent_error', finishedAt: new Date(), errorJson: result.error ?? result.rawResponse } as any,
          });
          const failed = await prisma.message.update({ where: { id: messageId }, data: { status: MessageStatus.failed } });
          await prisma.messageStatusHistory.create({
            data: { messageId, status: MessageStatus.failed, source: adapterName, payload: (result.error ?? result.rawResponse) as any },
          });
          await this.raiseSendFailureAlert(messageId, result.error?.message ?? 'permanent error');
          await this.emitMessageEvent('message.failed', failed as Message, { error: result.error?.message });
          return;
        }
        throw new SendAttemptError(result.error?.message ?? 'retryable error', false);
      }

      // Adapters that support delivery receipts (most of them) will update
      // status to `delivered` via `normalizeStatus` callbacks; here we only
      // emit `sent`.
      const nextStatus: MessageStatus = MessageStatus.sent;
      const updated = await prisma.message.update({
        where: { id: messageId },
        data: { status: nextStatus, externalId: result.externalId ?? null },
      });
      await prisma.messageStatusHistory.create({
        data: { messageId, status: nextStatus, source: adapterName, payload: result.rawResponse as any } as any,
      });
      await prisma.messageAttempt.update({
        where: { id: attempt.id },
        data: { result: 'sent', finishedAt: new Date() },
      });
      const eventType = 'message.sent' as const;
      await this.emitMessageEvent(eventType, updated as Message, { adapter: adapterName });
    } catch (err) {
      const error = err as Error & { permanent?: boolean };
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

class SendAttemptError extends Error {
  constructor(message: string, public readonly permanent?: boolean) {
    super(message);
  }
}
