import { randomUUID } from 'crypto';
import type {
  AccountConfig,
  AdapterCapabilities,
  AdapterHealth,
  CanonicalInbound,
  CanonicalOutbound,
  CanonicalStatus,
  EndpointConfig,
  SendResult,
} from '@umg/channel-sdk';

/**
 * Mock adapter — kept identical to the existing `MockAdapter` in
 * `apps/worker/src/adapters/mock.adapter.ts` so behaviour matches in both
 * dev/test and prod until someone swaps it out for a real adapter.
 *
 * The pre-existing worker file continues to be used by the worker module
 * via simple injection; this version is exposed through the registry so
 * callers don't need a hard reference to `apps/worker`.
 */
export class MockAdapter {
  readonly name = 'mock';

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      send: ['text', 'image', 'audio', 'voice', 'video', 'document', 'sticker', 'location', 'contact', 'reaction'],
      receive: ['text', 'image', 'audio', 'voice', 'video', 'document', 'sticker', 'location', 'contact', 'reaction'],
      features: {
        delivery_status: true,
        read_status: true,
        reply: true,
        groups: true,
        reactions: true,
        voice: true,
        media: true,
      },
    };
  }

  async healthCheck(_account: AccountConfig): Promise<AdapterHealth> {
    return { ok: true, details: { provider: 'mock' }, checkedAt: new Date() };
  }

  async send(_outbound: CanonicalOutbound, _endpoint: EndpointConfig, _account: AccountConfig): Promise<SendResult> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      externalId: `mock-${randomUUID()}`,
      accepted: true,
      rawResponse: { provider: 'mock', result: 'ok' },
    };
  }

  normalizeStatus(_account: AccountConfig, _raw: unknown): CanonicalStatus | null {
    return null;
  }

  normalizeInbound(_account: AccountConfig, _endpoint: EndpointConfig, _raw: unknown): CanonicalInbound[] {
    return [];
  }
}
