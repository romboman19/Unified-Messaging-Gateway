import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InboundQueueService } from './inbound-queue.service';

/**
 * Vendor-facing inbound webhooks (TZ §15.1 — inbound ingestion).
 *
 * These routes are the one part of the API that is NOT session-guarded: the
 * caller is a sidecar on the `transports` network, not a browser. Authenticity
 * comes from a shared-secret HMAC over the raw request body, so the raw bytes
 * must survive JSON parsing — see `rawBody: true` in main.ts.
 *
 * The controller does no interpretation of its own. It authenticates, hands
 * the payload to the worker queue, and returns 200 quickly: vendors retry
 * aggressively on non-2xx, and a slow receiver turns into duplicate events.
 */
@Controller('webhooks')
export class InboundWebhooksController {
  private readonly logger = new Logger(InboundWebhooksController.name);

  constructor(private readonly queue: InboundQueueService) {}

  /**
   * go-whatsapp-web-multidevice signs every delivery with
   * `X-Hub-Signature-256: sha256=<hex hmac-sha256(body, webhook-secret)>`
   * (infrastructure/whatsapp/webhook.go). The same secret is passed to the
   * sidecar as `--webhook-secret` in docker-compose.prod.yml.
   */
  @Post('gwmd')
  @HttpCode(200)
  async gwmd(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const secret = process.env.GWMD_WEBHOOK_SECRET ?? '';
    if (!secret) {
      // Refuse rather than accept unauthenticated writes into the message
      // store — an unset secret is a deployment error, not a relaxed mode.
      this.logger.error('GWMD_WEBHOOK_SECRET is not set; rejecting webhook');
      throw new UnauthorizedException('Webhook secret not configured.');
    }
    if (!this.verify(req.rawBody, signature, secret)) {
      this.logger.warn('Rejected gwmd webhook with bad or missing signature');
      throw new UnauthorizedException('Bad signature.');
    }

    await this.queue.enqueueInbound('gwmd', body);
    return { ok: true };
  }

  /**
   * DBLtek GoIP SMS Server forwards inbound SMS to the URL set in its System
   * Settings: `{ goip_line, from_number, content, recv_time }`.
   *
   * Unlike gwmd it signs nothing — the vendor offers no signature or token on
   * this callback at all. The only thing protecting it is the network: the SMS
   * Server sits on the internal `transports` network, so nothing off-host can
   * reach this route. A shared secret in the query string is accepted when
   * `DBSMS_WEBHOOK_SECRET` is set, since the forwarding URL is free-form and
   * can carry one.
   */
  @Post('dbsms')
  @HttpCode(200)
  async dbsms(
    @Query('secret') secret: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const expected = process.env.DBSMS_WEBHOOK_SECRET ?? '';
    if (expected && secret !== expected) {
      this.logger.warn('Rejected dbsms webhook with a bad secret');
      throw new UnauthorizedException('Bad secret.');
    }
    await this.queue.enqueueInbound('goip-vendor', body);
    return { ok: true };
  }

  private verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    secret: string,
  ): boolean {
    if (!rawBody || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const received = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    // timingSafeEqual throws on length mismatch, which itself leaks nothing
    // useful here — a wrong-length digest is wrong regardless.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
