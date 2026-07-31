import { ChannelAdapterRegistry, type ChannelAdapter } from '@umg/channel-sdk';
import { SignalCliRestApiAdapter } from './signal/index.js';
import { UnoApiAdapter } from './unoapi/index.js';
import { GoipVendorAdapter } from './goip-vendor/index.js';
import { MockAdapter } from './mock/index.js';

export * from './mock/index.js';
export * from './signal/index.js';
export * from './unoapi/index.js';
export * from './goip-vendor/index.js';

/**
 * Register every built-in adapter on the given registry.
 */
export function registerBuiltinAdapters(
  registry: ChannelAdapterRegistry = new ChannelAdapterRegistry(),
): ChannelAdapterRegistry {
  registry.register('mock', () => new MockAdapter());
  registry.register('goip-vendor', () => new GoipVendorAdapter());
  registry.register('unoapi', () => new UnoApiAdapter());
  registry.register('signal-cli-rest-api', () => new SignalCliRestApiAdapter());
  return registry;
}

/** Default registry with all built-ins. */
export const defaultRegistry = registerBuiltinAdapters();

export type { ChannelAdapter };
