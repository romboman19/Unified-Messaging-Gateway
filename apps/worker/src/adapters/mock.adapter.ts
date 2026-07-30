import { Injectable } from '@nestjs/common';
import { TransportAdapter, SendResult } from './adapter.interface';
import { randomUUID } from 'crypto';

@Injectable()
export class MockAdapter implements TransportAdapter {
  async send(_message: unknown): Promise<SendResult> {
    // Simulate short network delay and deterministic success.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      externalId: `mock-${randomUUID()}`,
      status: 'sent',
      raw: { provider: 'mock', result: 'ok' },
    };
  }
}
