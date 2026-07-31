import type { ChannelAdapter } from './adapter.js';

/**
 * Registry of adapter implementations, keyed by adapter name.
 *
 * The worker resolves `transport_accounts.adapter` to an instance here.
 * Adding a new vendor = new entry in this map; no core DB changes needed
 * (TZ `adapters.md` §5).
 */
export class ChannelAdapterRegistry {
  private readonly factories = new Map<string, () => ChannelAdapter>();

  /** Register a factory for an adapter name. */
  register(name: string, factory: () => ChannelAdapter): void {
    this.factories.set(name, factory);
  }

  /** Returns true if an adapter with this name is registered. */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** Instantiate the adapter. Throws if unknown. */
  get(name: string): ChannelAdapter {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown channel adapter: ${name}`);
    }
    return factory();
  }

  /** List of all registered adapter names. */
  list(): string[] {
    return [...this.factories.keys()];
  }
}

/** Default global registry; consumers may create their own for tests. */
export const defaultRegistry = new ChannelAdapterRegistry();
