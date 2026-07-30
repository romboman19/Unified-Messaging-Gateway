import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { createHmac } from 'crypto';
import * as nodemailer from 'nodemailer';
import {
  PrismaClient,
  Prisma,
  WebhookDelivery,
  WebhookDestination,
  MessageEvent,
} from '@umg/database';
import { EventsService } from '../events/events.service';
import { AlertsService } from '../alerts/alerts.service';
import { WebhookDeliverJobData } from '../routing/routing.service';

/** Backoff after the immediate first attempt (spec §15.5 / §44). */
const RETRY_SCHEDULE_SECONDS = [60, 300, 900, 3600] as const;
const RESPONSE_EXCERPT_LIMIT = 2048;
const DEFAULT_TIMEOUT_MS = 10000;

interface DeliveryOutcome {
  ok: boolean;
  permanent?: boolean;
  statusCode?: number;
  excerpt?: string;
  error?: string;
}

interface SmtpSettings {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  fromName?: string;
  fromAddress?: string;
}

@Processor('webhook.deliver')
export class WebhookDeliverProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookDeliverProcessor.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @InjectQueue('webhook.deliver') private readonly webhookQueue: Queue,
    private readonly eventsService: EventsService,
    private readonly alertsService: AlertsService,
  ) {
    super();
  }

  async process(job: Job<WebhookDeliverJobData>): Promise<void> {
    const { deliveryId } = job.data;
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { event: true, destination: true },
    });
    if (!delivery) {
      this.logger.error(`Delivery ${deliveryId} not found, job ${job.id} acknowledged`);
      return;
    }
    if (delivery.status === 'delivered' || delivery.status === 'dlq' || delivery.status === 'failed') {
      this.logger.log(`Delivery ${deliveryId} already in terminal state ${delivery.status}, skipping`);
      return;
    }

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'delivering' },
    });

    const attemptHeader = delivery.attemptCount + 1;
    const startedAt = Date.now();
    this.logger.log(
      `Delivering ${delivery.event.eventType} to "${delivery.destination.name}" attempt ${attemptHeader}`,
    );

    const outcome = await this.executeDelivery(delivery, attemptHeader);
    const durationMs = Date.now() - startedAt;

    if (outcome.ok) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'delivered',
          lastResponseCode: outcome.statusCode ?? null,
          lastError: null,
          nextAttemptAt: null,
          durationMs,
          responseJson: this.responseSnapshot(outcome),
        },
      });
      this.logger.log(`Delivery ${deliveryId} delivered in ${durationMs}ms`);
      return;
    }

    if (outcome.permanent) {
      await this.prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'failed',
          lastResponseCode: outcome.statusCode ?? null,
          lastError: outcome.error ?? 'Постійна помилка доставки',
          nextAttemptAt: null,
          durationMs,
          responseJson: this.responseSnapshot(outcome),
        },
      });
      this.logger.warn(
        `Delivery ${deliveryId} permanently failed: ${outcome.error ?? 'unknown reason'}`,
      );
      return;
    }

    await this.handleTemporaryFailure(delivery, outcome, durationMs);
  }

  private responseSnapshot(outcome: DeliveryOutcome): Prisma.InputJsonValue {
    const snapshot: Record<string, unknown> = {};
    if (outcome.statusCode !== undefined) snapshot.status = outcome.statusCode;
    if (outcome.excerpt !== undefined) snapshot.body = outcome.excerpt;
    if (outcome.error !== undefined) snapshot.error = outcome.error;
    return snapshot as Prisma.InputJsonValue;
  }

  private executeDelivery(
    delivery: WebhookDelivery & { event: MessageEvent; destination: WebhookDestination },
    attemptHeader: number,
  ): Promise<DeliveryOutcome> {
    switch (delivery.destination.type) {
      case 'webhook':
        return this.deliverWebhook(delivery, attemptHeader);
      case 'telegram':
        return this.deliverTelegram(delivery);
      case 'email':
        return this.deliverEmail(delivery);
      case 'internal_log':
        // Event is already persisted in message_events; nothing else to do.
        return Promise.resolve({ ok: true });
      default:
        return Promise.resolve({
          ok: false,
          permanent: true,
          error: `Невідомий тип призначення: ${String(delivery.destination.type)}`,
        });
    }
  }

  private bodyOf(delivery: WebhookDelivery & { event: MessageEvent }): string {
    return JSON.stringify(delivery.requestJson ?? delivery.event.payload ?? {});
  }

  private eventIdHeader(event: MessageEvent): string {
    const envelope = event.payload as Record<string, unknown> | null;
    const id = envelope && typeof envelope.id === 'string' ? envelope.id : null;
    return id ?? event.id;
  }

  private async deliverWebhook(
    delivery: WebhookDelivery & { event: MessageEvent; destination: WebhookDestination },
    attemptHeader: number,
  ): Promise<DeliveryOutcome> {
    const destination = delivery.destination;
    const url = destination.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        permanent: true,
        error: `Невалідна URL вебхука: очікується http:// або https://`,
      };
    }

    const body = this.bodyOf(delivery);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-UMG-Event-Id': this.eventIdHeader(delivery.event),
      'X-UMG-Timestamp': timestamp,
      'X-UMG-Attempt': String(attemptHeader),
    };
    if (destination.secretEnc) {
      const signature = createHmac('sha256', destination.secretEnc)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      headers['X-UMG-Signature'] = `sha256=${signature}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(destination.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const excerpt = (await response.text()).slice(0, RESPONSE_EXCERPT_LIMIT);
      if (response.ok) {
        return { ok: true, statusCode: response.status, excerpt };
      }
      const permanent =
        response.status >= 400 && response.status < 500 && response.status !== 429;
      return {
        ok: false,
        permanent,
        statusCode: response.status,
        excerpt,
        error: permanent
          ? `Постійна помилка вебхука: HTTP ${response.status}`
          : `Тимчасова помилка вебхука: HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        permanent: false,
        error: `Мережева помилка або таймаут: ${(err as Error).message}`,
      };
    }
  }

  private buildTelegramSummary(event: MessageEvent): string {
    const envelope = (event.payload ?? {}) as Record<string, unknown>;
    const channel =
      typeof envelope.channel === 'string' ? envelope.channel : event.channelType ?? '—';
    const time = typeof envelope.time === 'string' ? envelope.time : event.createdAt.toISOString();
    return [`Подія UMG`, `Тип: ${event.eventType}`, `Канал: ${channel}`, `Час: ${time}`].join('\n');
  }

  private async deliverTelegram(
    delivery: WebhookDelivery & { event: MessageEvent; destination: WebhookDestination },
  ): Promise<DeliveryOutcome> {
    const destination = delivery.destination;
    const config = (destination.configJson ?? {}) as { botToken?: string; chatId?: string | number };
    if (!config.botToken || config.chatId === undefined || config.chatId === null || config.chatId === '') {
      return {
        ok: false,
        permanent: true,
        error: 'Відсутня конфігурація Telegram: потрібні botToken та chatId',
      };
    }

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: this.buildTelegramSummary(delivery.event),
        }),
        signal: AbortSignal.timeout(destination.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const excerpt = (await response.text()).slice(0, RESPONSE_EXCERPT_LIMIT);
      if (response.ok) {
        return { ok: true, statusCode: response.status, excerpt };
      }
      const permanent =
        response.status >= 400 && response.status < 500 && response.status !== 429;
      return {
        ok: false,
        permanent,
        statusCode: response.status,
        excerpt,
        error: permanent
          ? `Постійна помилка Telegram: HTTP ${response.status}`
          : `Тимчасова помилка Telegram: HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        permanent: false,
        error: `Мережева помилка Telegram: ${(err as Error).message}`,
      };
    }
  }

  private async deliverEmail(
    delivery: WebhookDelivery & { event: MessageEvent; destination: WebhookDestination },
  ): Promise<DeliveryOutcome> {
    const destination = delivery.destination;
    const config = (destination.configJson ?? {}) as { recipients?: string[] };
    if (!Array.isArray(config.recipients) || config.recipients.length === 0) {
      return {
        ok: false,
        permanent: true,
        error: 'Не вказано отримувачів email (configJson.recipients)',
      };
    }

    const setting = await this.prisma.systemSetting.findUnique({ where: { key: 'smtp' } });
    const smtp = (setting?.valueJson ?? {}) as SmtpSettings;
    if (!setting || !smtp.host || !smtp.port || !smtp.fromAddress) {
      return { ok: false, permanent: true, error: 'SMTP не налаштовано' };
    }

    try {
      const timeoutMs = destination.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure ?? false,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
        connectionTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      await transporter.sendMail({
        from: `"${smtp.fromName ?? 'UMG'}" <${smtp.fromAddress}>`,
        to: config.recipients.join(', '),
        subject: `[UMG] ${delivery.event.eventType}`,
        text: JSON.stringify(delivery.requestJson ?? delivery.event.payload, null, 2),
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        permanent: false,
        error: `Помилка надсилання email: ${(err as Error).message}`,
      };
    }
  }

  private async handleTemporaryFailure(
    delivery: WebhookDelivery & { event: MessageEvent; destination: WebhookDestination },
    outcome: DeliveryOutcome,
    durationMs: number,
  ): Promise<void> {
    const attemptCount = delivery.attemptCount + 1;
    const maxAttempts = delivery.maxAttempts || 5;
    const lastError = outcome.error ?? 'Невідома помилка доставки';

    if (attemptCount < maxAttempts) {
      const delaySeconds =
        RETRY_SCHEDULE_SECONDS[Math.min(attemptCount - 1, RETRY_SCHEDULE_SECONDS.length - 1)];
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'pending',
          attemptCount,
          nextAttemptAt,
          lastError,
          lastResponseCode: outcome.statusCode ?? null,
          durationMs,
          responseJson: this.responseSnapshot(outcome),
        },
      });
      const jobData: WebhookDeliverJobData = { deliveryId: delivery.id };
      await this.webhookQueue.add('deliver', jobData, {
        jobId: `${delivery.id}-retry-${attemptCount}`,
        delay: delaySeconds * 1000,
      });
      this.logger.warn(
        `Delivery ${delivery.id} attempt ${attemptCount} failed, retry in ${delaySeconds}s: ${lastError}`,
      );
      return;
    }

    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'dlq',
        attemptCount,
        nextAttemptAt: null,
        lastError,
        lastResponseCode: outcome.statusCode ?? null,
        durationMs,
        responseJson: this.responseSnapshot(outcome),
      },
    });
    this.logger.error(
      `Delivery ${delivery.id} dead-lettered after ${maxAttempts} attempts: ${lastError}`,
    );

    await this.eventsService.emit({
      type: 'webhook.dead_lettered',
      aggregateId: delivery.id,
      data: {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        destinationId: delivery.destinationId,
        error: lastError,
        attempts: attemptCount,
      },
      dedupKey: `dlq-${delivery.id}-webhook.dead_lettered`,
    });

    await this.alertsService.raise({
      fingerprint: `webhook-dlq:${delivery.destinationId}`,
      ruleKey: 'webhook.dead_lettered',
      severity: 'warning',
      title: 'Вебхук dead-lettered',
      message: `Доставка події ${delivery.event.eventType} до "${delivery.destination.name}" не вдалася після ${maxAttempts} спроб.`,
      payload: {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        destinationId: delivery.destinationId,
        error: lastError,
      },
    });
  }
}
