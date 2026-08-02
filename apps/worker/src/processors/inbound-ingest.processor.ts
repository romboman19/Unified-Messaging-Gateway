import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InboundIngestService } from '../inbound/inbound-ingest.service';

export const INBOUND_INGEST_QUEUE = 'inbound.ingest';

interface InboundIngestJobData {
  adapter: string;
  payload: unknown;
}

/**
 * Drains webhook payloads the API accepted and authenticated. Keeping the work
 * here rather than in the API means the vendor gets its 200 immediately and
 * slow DB work never turns into a webhook retry storm.
 */
@Processor(INBOUND_INGEST_QUEUE)
export class InboundIngestProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundIngestProcessor.name);

  constructor(private readonly ingest: InboundIngestService) {
    super();
  }

  async process(job: Job<InboundIngestJobData>): Promise<void> {
    const { adapter, payload } = job.data;
    const stored = await this.ingest.ingest(adapter, payload);
    this.logger.debug(`Job ${job.id}: ${adapter} payload produced ${stored} message(s)`);
  }
}
