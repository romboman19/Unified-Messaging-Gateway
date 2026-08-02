import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const INBOUND_INGEST_QUEUE = 'inbound.ingest';

export interface InboundIngestJobData {
  /** Adapter name the payload came from, e.g. "gwmd". */
  adapter: string;
  /** Raw vendor payload, handed to `adapter.normalizeInbound` unmodified. */
  payload: unknown;
}

@Injectable()
export class InboundQueueService {
  constructor(
    @InjectQueue(INBOUND_INGEST_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueInbound(adapter: string, payload: unknown): Promise<void> {
    await this.queue.add('ingest', { adapter, payload } satisfies InboundIngestJobData);
  }
}
