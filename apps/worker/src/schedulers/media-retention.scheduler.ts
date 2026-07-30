import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient } from '@umg/database';
import { EventsService } from '../events/events.service';
import { promises as fs } from 'fs';
import * as path from 'path';

const DEFAULT_RETENTION_DAYS = 60;
const BATCH_LIMIT = 200;

/**
 * Daily media retention cleanup (spec §26): deletes attachment files older
 * than the retention window, marks them deleted, and emits media.deleted.
 */
@Injectable()
export class MediaRetentionScheduler {
  private readonly logger = new Logger(MediaRetentionScheduler.name);
  private readonly basePath = process.env.MEDIA_STORAGE_PATH ?? '/data/media';

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly eventsService: EventsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredMedia(): Promise<void> {
    const retentionDays = await this.loadRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    this.logger.log(
      `Media retention cleanup started: retention=${retentionDays}d cutoff=${cutoff.toISOString()}`,
    );

    const expired = await this.prisma.attachment.findMany({
      where: { deletedAt: null, createdAt: { lt: cutoff } },
      take: BATCH_LIMIT,
      orderBy: { createdAt: 'asc' },
    });
    if (expired.length === 0) {
      this.logger.log('Media retention cleanup finished: nothing to delete');
      return;
    }

    let deleted = 0;
    for (const attachment of expired) {
      try {
        await this.deleteFile(attachment.storagePath);
        await this.prisma.attachment.update({
          where: { id: attachment.id },
          data: { deletedAt: new Date() },
        });
        await this.eventsService.emit({
          type: 'media.deleted',
          aggregateId: attachment.messageId ?? undefined,
          data: {
            attachment: {
              id: attachment.id,
              messageId: attachment.messageId,
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          },
          dedupKey: `media-${attachment.id}-media.deleted`,
        });
        deleted += 1;
      } catch (err) {
        this.logger.error(
          `Failed to delete attachment ${attachment.id}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Media retention cleanup finished: ${deleted}/${expired.length} attachment(s) deleted`,
    );
  }

  private async deleteFile(storagePath: string): Promise<void> {
    const resolved = path.resolve(this.basePath, storagePath);
    if (!resolved.startsWith(path.resolve(this.basePath) + path.sep)) {
      this.logger.warn(`Skipping attachment with path outside media root: ${storagePath}`);
      return;
    }
    try {
      await fs.unlink(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug(`Media file already absent: ${resolved}`);
        return;
      }
      throw err;
    }
  }

  private async loadRetentionDays(): Promise<number> {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'media.retentionDays' },
    });
    const value = setting?.valueJson;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { days?: unknown }).days === 'number'
    ) {
      const days = (value as { days: number }).days;
      if (Number.isFinite(days) && days > 0) return Math.floor(days);
    }
    return DEFAULT_RETENTION_DAYS;
  }
}
