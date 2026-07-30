import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaClient, MessageStatus } from '@umg/database';

interface SendJobData {
  messageId: string;
}

@Injectable()
export class ScheduledSendScheduler {
  private readonly logger = new Logger(ScheduledSendScheduler.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @InjectQueue('message.send') private readonly sendQueue: Queue,
  ) {}

  @Cron('*/15 * * * * *')
  async dispatchDueMessages(): Promise<void> {
    const now = new Date();
    const due = await this.prisma.message.findMany({
      where: { status: 'scheduled', scheduledAt: { lte: now } },
      take: 50,
      orderBy: { scheduledAt: 'asc' },
      select: { id: true },
    });
    if (due.length === 0) return;

    this.logger.log(`Dispatching ${due.length} scheduled message(s)`);
    for (const { id } of due) {
      // CAS guard: only the worker that flips scheduled -> queued enqueues the job.
      const claimed = await this.prisma.message.updateMany({
        where: { id, status: 'scheduled' },
        data: { status: MessageStatus.queued },
      });
      if (claimed.count === 0) continue;

      await this.prisma.messageStatusHistory.create({
        data: {
          messageId: id,
          status: MessageStatus.queued,
          source: 'scheduled_send_scheduler',
          payload: { reason: 'scheduledAt reached' },
        },
      });

      try {
        const jobData: SendJobData = { messageId: id };
        await this.sendQueue.add('send', jobData, {
          jobId: id,
          attempts: 3,
          backoff: { type: 'fixed', delay: 60_000 },
        });
      } catch (err) {
        // Duplicate job id (already enqueued elsewhere) is acceptable.
        this.logger.warn(`Could not enqueue send job for message ${id}: ${(err as Error).message}`);
      }
    }
  }
}
