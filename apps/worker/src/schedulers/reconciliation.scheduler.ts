import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient } from '@umg/database';

interface SendJobData {
  messageId: string;
}

const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Re-enqueues messages stuck in queued/dispatching without an active BullMQ
 * job (e.g. after Redis loss/restart), per spec §28.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @InjectQueue('message.send') private readonly sendQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcile();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcile(): Promise<void> {
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
    const stuck = await this.prisma.message.findMany({
      where: {
        status: { in: ['queued', 'dispatching'] },
        updatedAt: { lt: staleBefore },
      },
      take: 100,
      orderBy: { updatedAt: 'asc' },
      select: { id: true, status: true },
    });
    if (stuck.length === 0) return;

    for (const message of stuck) {
      try {
        const job = await this.sendQueue.getJob(message.id);
        if (job) continue;
        const jobData: SendJobData = { messageId: message.id };
        await this.sendQueue.add('send', jobData, {
          jobId: message.id,
          attempts: 3,
          backoff: { type: 'fixed', delay: 60_000 },
        });
        this.logger.warn(
          `Recovered stuck message ${message.id} (status ${message.status}) — re-enqueued send job`,
        );
      } catch (err) {
        this.logger.error(
          `Reconciliation failed for message ${message.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}
