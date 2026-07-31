import { Injectable } from '@nestjs/common';
import { ChannelAdapterRegistry, type ChannelAdapter } from '@umg/channel-sdk';
import { registerBuiltinAdapters } from '@umg/adapters';

/**
 * Worker-side provider that exposes the singleton adapter registry with
 * all built-in adapters registered (mock, goip-vendor, unoapi,
 * signal-cli-rest-api). Custom transports can be added by overriding this
 * provider or calling `registry.register(...)` in `onModuleInit`.
 */
@Injectable()
export class AdaptersRegistry extends ChannelAdapterRegistry {
  constructor() {
    super();
    registerBuiltinAdapters(this);
  }
}

/**
 * Backwards-compatible wrapper that keeps the existing
 * `MockAdapter` usage in `MessageSendProcessor` working: callers that
 * still inject `MockAdapter` get the registry's `mock` entry resolved
 * dynamically so a test can swap in a fake.
 */
@Injectable()
export class AdaptersFacade {
  constructor(private readonly registry: AdaptersRegistry) {}

  resolve(adapterName: string): ChannelAdapter {
    return this.registry.get(adapterName);
  }
}
