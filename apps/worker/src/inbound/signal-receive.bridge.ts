import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient, RegistrationState } from '@umg/database';
import { InboundIngestService } from './inbound-ingest.service';

const SIGNAL_ADAPTER = 'signal-cli-rest-api';

/**
 * Keeps a websocket open to signal-cli for every linked Signal number.
 *
 * Signal has no webhook. In `MODE=json-rpc` the sidecar exposes
 * `GET /v1/receive/{number}` as a websocket upgrade and streams envelopes as
 * they arrive. Nothing drains that socket unless we hold it open — and an
 * undrained Signal queue is visible to the *sender*, whose client keeps
 * showing the message as undelivered. So this bridge is not just how messages
 * reach the UI; it is what makes delivery work at all.
 *
 * One socket per linked number, reconciled every 30s so numbers linked
 * through the wizard start receiving without a worker restart.
 */
@Injectable()
export class SignalReceiveBridge implements OnModuleDestroy {
  private readonly logger = new Logger(SignalReceiveBridge.name);
  /** phone → live socket */
  private readonly sockets = new Map<string, WebSocket>();
  /** phone → endpoint id, captured when the socket was opened */
  private readonly endpointIds = new Map<string, string>();
  private stopping = false;

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly ingest: InboundIngestService,
  ) {}

  onModuleDestroy(): void {
    this.stopping = true;
    for (const [phone, ws] of this.sockets) {
      this.logger.log(`Closing Signal receive socket for ${phone}`);
      try {
        ws.close();
      } catch {
        // Already closing — nothing to do.
      }
    }
    this.sockets.clear();
  }

  @Interval(30_000)
  async reconcile(): Promise<void> {
    if (this.stopping) return;
    const account = await this.prisma.transportAccount.findFirst({
      where: { adapter: SIGNAL_ADAPTER },
    });
    if (!account) return;

    const endpoints = await this.prisma.endpoint.findMany({
      where: {
        accountId: account.id,
        registrationState: RegistrationState.linked,
        enabled: true,
      },
    });

    const wanted = new Set<string>();
    for (const ep of endpoints) {
      const phone = ep.phoneE164 ?? ep.externalId;
      if (!phone) continue;
      wanted.add(phone);
      this.endpointIds.set(phone, ep.id);
      if (!this.sockets.has(phone)) {
        this.open(phone, this.baseUrl(account.encryptedConfig));
      }
    }

    // Drop sockets for numbers that were unlinked or disabled meanwhile.
    for (const [phone, ws] of this.sockets) {
      if (!wanted.has(phone)) {
        this.logger.log(`Endpoint for ${phone} is gone; closing its receive socket`);
        this.sockets.delete(phone);
        try {
          ws.close();
        } catch {
          // Already closing.
        }
      }
    }
  }

  private baseUrl(config: unknown): string {
    const cfg = (config as Record<string, unknown>) ?? {};
    return (cfg['baseUrl'] as string) ?? process.env.SIGNAL_BASE_URL ?? 'http://signal-cli:8080';
  }

  private open(phone: string, baseUrl: string): void {
    const wsUrl =
      baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') +
      `/v1/receive/${encodeURIComponent(phone)}`;
    this.logger.log(`Opening Signal receive socket for ${phone}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      this.logger.error(`Could not open ${wsUrl}: ${(err as Error).message}`);
      return;
    }
    this.sockets.set(phone, ws);

    ws.addEventListener('message', (evt) => {
      void this.handleFrame(phone, evt.data);
    });

    ws.addEventListener('error', () => {
      // The close handler runs straight after and owns reconnection; logging
      // both would double up on every blip.
      this.logger.debug(`Signal receive socket for ${phone} errored`);
    });

    ws.addEventListener('close', () => {
      if (this.sockets.get(phone) === ws) this.sockets.delete(phone);
      if (this.stopping) return;
      // `reconcile` reopens on its next tick; no separate backoff timer to
      // get out of sync with the endpoint list.
      this.logger.warn(`Signal receive socket for ${phone} closed; will reopen`);
    });
  }

  private async handleFrame(phone: string, data: unknown): Promise<void> {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : String(data);
    if (!text.trim()) return;

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.logger.warn(`Ignoring non-JSON frame on ${phone}'s socket`);
      return;
    }

    const endpointId = this.endpointIds.get(phone);
    if (!endpointId) {
      this.logger.warn(`No endpoint id cached for ${phone}; dropping frame`);
      return;
    }

    try {
      await this.ingest.ingest(SIGNAL_ADAPTER, payload, endpointId);
    } catch (err) {
      this.logger.error(`Failed ingesting Signal frame for ${phone}: ${(err as Error).message}`);
    }
  }
}
