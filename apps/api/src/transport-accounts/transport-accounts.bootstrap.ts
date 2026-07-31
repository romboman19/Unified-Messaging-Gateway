import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChannelType, PrismaClient } from '@umg/database';

/**
 * Default transport accounts bootstrapped on API startup.
 *
 * The system owns these three adapters — they map 1:1 to the vendor
 * sidecars on the `transports` network (TZ §21/§23/§24, ADR-002):
 *
 *   sms       ← goip-vendor        (DBLtek GoIP SMS Server v1.30.1)
 *   whatsapp  ← unoapi             (UnoAPI / WhatsApp Cloud API)
 *   signal    ← signal-cli-rest-api (bbernhard/signal-cli-rest-api)
 *
 * Per-channel credentials come from environment variables so production
 * can swap the sidecar URLs without rebuilding. Endpoint rows (SIM lines /
 * phone numbers) are managed by users through the Channels UI.
 */
interface SeedSpec {
  adapter: string;
  type: ChannelType;
  name: string;
  config: Record<string, unknown>;
}

@Injectable()
export class TransportAccountsBootstrapService {
  private readonly logger = new Logger(TransportAccountsBootstrapService.name);

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {
    void this.seed();
  }

  private seedSpecs(): SeedSpec[] {
    const specs: SeedSpec[] = [];
    if (process.env.DBSMS_BASE_URL) {
      specs.push({
        adapter: 'goip-vendor',
        type: ChannelType.sms,
        name: 'SMS / DBLtek GoIP',
        config: {
          baseUrl: process.env.DBSMS_BASE_URL,
          username: process.env.DBSMS_USERNAME ?? '',
          password: process.env.DBSMS_PASSWORD ?? '',
        },
      });
    }
    if (process.env.UNOAPI_BASE_URL) {
      specs.push({
        adapter: 'unoapi',
        type: ChannelType.whatsapp,
        name: 'WhatsApp / UnoAPI',
        config: {
          baseUrl: process.env.UNOAPI_BASE_URL,
          apiKey: process.env.UNOAPI_API_KEY ?? '',
        },
      });
    }
    if (process.env.SIGNAL_BASE_URL) {
      specs.push({
        adapter: 'signal-cli-rest-api',
        type: ChannelType.signal,
        name: 'Signal / signal-cli-rest-api',
        config: {
          baseUrl: process.env.SIGNAL_BASE_URL,
          mode: process.env.SIGNAL_CLI_MODE ?? 'json-rpc',
        },
      });
    }
    return specs;
  }

  async seed(): Promise<void> {
    const specs = this.seedSpecs();
    if (specs.length === 0) {
      this.logger.warn(
        'No transport sidecar URLs configured (DBSMS_BASE_URL / UNOAPI_BASE_URL / SIGNAL_BASE_URL); ' +
          'skipping transport-account seed.',
      );
      return;
    }
    for (const spec of specs) {
      try {
        const existing = await this.prisma.transportAccount.findFirst({
          where: { adapter: spec.adapter },
        });
        if (existing) {
          // Keep config fresh so credential rotations on the sidecar don't
          // require a DB write.
          await this.prisma.transportAccount.update({
            where: { id: existing.id },
            data: {
              encryptedConfig: spec.config as never,
              status: 'active',
            },
          });
          continue;
        }
        const created = await this.prisma.transportAccount.create({
          data: {
            adapter: spec.adapter,
            type: spec.type,
            name: spec.name,
            status: 'active',
            encryptedConfig: spec.config as never,
          },
        });
        this.logger.log(
          `Seeded transport account "${created.name}" (${created.adapter}, ${created.type})`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to seed transport account ${spec.adapter}/${spec.type}: ${(err as Error).message}`,
        );
      }
    }
  }
}
