import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaClient } from '@umg/database';
import { RoutingService } from '../routing/routing.service';

@Injectable()
export class OutboxDispatcherScheduler {
  private readonly logger = new Logger(OutboxDispatcherScheduler.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly routingService: RoutingService,
  ) {}

  @Cron('*/3 * * * * *')
  async dispatchOutbox(): Promise<void> {
    const rows = await this.prisma.eventOutbox.findMany({
      where: { publishedAt: null },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return;

    this.logger.debug(`Processing ${rows.length} unpublished outbox record(s)`);
    for (const row of rows) {
      try {
        const payload = (row.payload ?? {}) as { messageEventId?: string };
        if (!payload.messageEventId) {
          this.logger.error(`Outbox ${row.id} has no messageEventId in payload`);
          continue;
        }
        const event = await this.prisma.messageEvent.findUnique({
          where: { id: payload.messageEventId },
        });
        if (!event) {
          this.logger.error(
            `Outbox ${row.id} references missing event ${payload.messageEventId}, left unpublished`,
          );
          continue;
        }

        await this.routingService.matchAndDispatch(event);

        // Idempotent publish marker: only flip when still unpublished.
        await this.prisma.eventOutbox.updateMany({
          where: { id: row.id, publishedAt: null },
          data: { publishedAt: new Date() },
        });
      } catch (err) {
        // Leave unpublished so the next tick retries.
        this.logger.error(`Outbox ${row.id} dispatch failed: ${(err as Error).message}`);
      }
    }
  }
}
