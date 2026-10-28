import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InboundIngestService } from '../inbound/inbound-ingest.service';

/** Turns buffered long-SMS segments into messages once each set is complete. */
@Injectable()
export class SmsConcatScheduler {
  private readonly logger = new Logger(SmsConcatScheduler.name);
  private running = false;

  constructor(private readonly ingest: InboundIngestService) {}

  @Cron('*/5 * * * * *')
  async flush(): Promise<void> {
    // A slow tick must not overlap the next one and store a set twice.
    if (this.running) return;
    this.running = true;
    try {
      const stored = await this.ingest.flushSmsParts();
      if (stored > 0) this.logger.log(`Stored ${stored} reassembled SMS`);
    } finally {
      this.running = false;
    }
  }
}
