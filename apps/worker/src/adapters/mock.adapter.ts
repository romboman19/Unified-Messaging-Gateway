import { Injectable } from '@nestjs/common';
import { TransportAdapter, SendResultLegacy } from './adapter.interface';
import { AdaptersRegistry } from './adapters.registry';

@Injectable()
export class MockAdapter implements TransportAdapter {
  constructor(private readonly registry: AdaptersRegistry) {}

  async send(_message: unknown): Promise<SendResultLegacy> {
    return this.registry.get('mock').send({} as any, {} as any, { id: 'mock', adapter: 'mock', configJson: {} } as any).then((r) => {
      const status = r.accepted ? 'sent' : 'failed';
      return {
        externalId: r.externalId ?? undefined,
        status: status as SendResultLegacy['status'],
        raw: r.rawResponse,
      } as SendResultLegacy;
    });
  }
}
