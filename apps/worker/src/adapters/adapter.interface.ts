/**
 * Re-export the canonical `ChannelAdapter` contract from `@umg/channel-sdk`
 * so existing imports keep working, and keep the legacy `TransportAdapter`
 * shape so the original `MockAdapter` keeps its current signature.
 */
export type {
  AccountConfig,
  AdapterCapabilities,
  AdapterHealth,
  CanonicalAddress,
  CanonicalInbound,
  CanonicalContent,
  CanonicalMessageType,
  CanonicalOutbound,
  CanonicalStatus,
  ChannelAdapter,
  EndpointConfig,
  SendResult,
  E164,
} from '@umg/channel-sdk';

export interface SendResultLegacy {
  externalId?: string;
  status: 'accepted' | 'sent' | 'delivered' | 'failed' | 'unknown';
  raw: unknown;
}

export interface TransportAdapter {
  send(message: unknown): Promise<SendResultLegacy>;
}
