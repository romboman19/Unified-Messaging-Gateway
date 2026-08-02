import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import {
  ChannelAdapter,
  ChannelAdapterRegistry,
  ProvisionedAccount,
  ProvisioningError,
  ProvisionQrResult,
  type AccountConfig,
} from '@umg/channel-sdk';
import { registerBuiltinAdapters } from '@umg/adapters';
import { PrismaClient, RegistrationState } from '@umg/database';
import { TransportAccountsService } from './transport-accounts.service';
import { AuditService } from '../common/audit.service';
import { ProvisionQrDto, ProvisionVerifyDto } from './provisioning.dto';

/**
 * Toolkit bridging the Channels wizard to the per-adapter provisioning
 * surface (TZ §1038).
 *
 * The API process owns the lifecycle (state on `Endpoint.registrationState`),
 * persistence, and audit. The adapter only knows how to talk to its
 * sidecar.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly registry: ChannelAdapterRegistry;

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly accounts: TransportAccountsService,
    private readonly audit: AuditService,
  ) {
    this.registry = registerBuiltinAdapters();
  }

  // ─────────────────── helpers ───────────────────

  private async getAdapter(accountId: string): Promise<{
    account: Awaited<ReturnType<TransportAccountsService['get']>>;
    adapter: ChannelAdapter;
    cap: 'qr' | 'sms' | 'voice' | 'none' | undefined;
  }> {
    const account = await this.accounts.get(accountId);
    if (!this.registry.has(account.adapter)) {
      throw new BadRequestException(`Невідомий адаптер: ${account.adapter}.`);
    }
    const adapter = this.registry.get(account.adapter);
    const caps = await adapter.capabilities();
    return { account, adapter, cap: caps.features.provisioning };
  }

  private accountConfig(account: { id: string; adapter: string; encryptedConfig: unknown }): AccountConfig {
    return {
      id: account.id,
      adapter: account.adapter,
      configJson: (account.encryptedConfig as Record<string, unknown>) ?? {},
    };
  }

  private async getEndpoint(endpointId: string) {
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId } });
    if (!ep) throw new NotFoundException('Endpoint не знайдено.');
    return ep;
  }

  private mapError(err: unknown): never {
    if (err instanceof ProvisioningError) {
      this.logger.warn(`provisioning error code=${err.code} retryable=${err.retryable}: ${err.message}`);
      switch (err.code) {
        case 'UNSUPPORTED':
          throw new NotImplementedException(err.message);
        case 'INVALID_INPUT':
          throw new BadRequestException(err.message);
        case 'TRANSPORT_ERROR':
        case 'BAD_RESPONSE':
          throw new BadGatewayException(err.message);
        case 'TIMEOUT':
          throw new GatewayTimeoutException(err.message);
        default:
          throw new InternalServerErrorException(err.message);
      }
    }
    throw err as Error;
  }

  // ─────────────────── public API ───────────────────

  /** Drive a Wizard to mint a QR for a fresh endpoint. */
  async startQr(accountId: string, dto: ProvisionQrDto, actorId: string | null) {
    const { account, adapter, cap } = await this.getAdapter(accountId);
    if (cap !== 'qr') {
      throw new BadRequestException('Цей канал не підтримує QR-реєстрацію.');
    }
    if (!adapter.provisionQr) {
      throw new NotImplementedException('Адаптер не реалізує QR-реєстрацію.');
    }

    // Normalise the per-kind payload into one of:
    //   signal   → { deviceName }
    //   whatsapp → { deviceName = phoneE164 }
    const deviceName = (dto.kind === 'whatsapp' ? dto.phoneE164 ?? '' : dto.deviceName ?? '').trim();
    if (!deviceName) {
      throw new BadRequestException(
        dto.kind === 'whatsapp'
          ? 'Для WhatsApp потрібен номер телефону.'
          : 'Для Signal потрібен deviceName.',
      );
    }

    // Snapshot what the sidecar already knows before we mint the QR.
    // Signal's `/v1/accounts` returns bare phone numbers with no device name
    // or uuid to match on, so the only way to tell which account the scan
    // produced is to diff against this baseline.
    let knownBefore: string[] = [];
    if (adapter.listProvisionedAccounts) {
      try {
        const before = await adapter.listProvisionedAccounts(this.accountConfig(account));
        knownBefore = before.map((a) => a.externalId).filter(Boolean);
      } catch (err) {
        // A sidecar that can't list yet shouldn't block pairing; we just
        // lose the diff strategy and fall back to identity matching.
        this.logger.warn(
          `Could not snapshot accounts for ${account.adapter}: ${(err as Error).message}`,
        );
      }
    }

    // 1. Create the endpoint row up-front so the wizard can poll against
    //    a stable id even if the user closes the tab mid-flow.
    const endpoint = await this.prisma.endpoint.create({
      data: {
        accountId,
        label: dto.label,
        deviceName,
        // For Signal: externalId stays unset until sidecar returns a number.
        // For WhatsApp: externalId is the phone (UnoAPI session id).
        externalId: dto.kind === 'whatsapp' ? deviceName : null,
        phoneE164: dto.kind === 'whatsapp' ? deviceName : null,
        registrationState: RegistrationState.qr_pending,
        enabled: false,
      },
    });

    try {
      const result: ProvisionQrResult = await adapter.provisionQr(
        this.accountConfig(account),
        { deviceName },
      );
      await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          registrationState: RegistrationState.qr_displayed,
          configJson: {
            qrSessionId: result.sessionId,
            qrExpiresAt: new Date(Date.now() + result.ttlSeconds * 1000).toISOString(),
            kind: dto.kind,
            knownAccountsBefore: knownBefore,
            // Sidecar-internal URL, never sent to the browser — the qr.png
            // route below fetches it server-side.
            qrImageUrl: result.imageUrl ?? null,
          } as never,
        },
      });
      await this.audit.log(
        actorId,
        'endpoint.provision.qr_requested',
        'endpoint',
        endpoint.id,
        {},
        { kind: dto.kind, deviceName, ttlSeconds: result.ttlSeconds },
      );
      return {
        endpointId: endpoint.id,
        // Exactly one of these is set: `uri` for sidecars that hand back an
        // encodable link (Signal), `qrImageUrl` for sidecars that render the
        // QR themselves (gwmd) and need the API to proxy the bytes.
        uri: result.imageUrl ? null : result.uri,
        qrImageUrl: result.imageUrl
          ? `/transport-accounts/${accountId}/provision/${endpoint.id}/qr.png`
          : null,
        ttlSeconds: result.ttlSeconds,
      };
    } catch (err) {
      await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: { registrationState: RegistrationState.failed },
      });
      await this.audit.log(
        actorId,
        'endpoint.provision.qr_failed',
        'endpoint',
        endpoint.id,
        {},
        { error: (err as Error).message },
      );
      this.mapError(err);
    }
  }

  /** Poll the sidecar to see if the linked device has appeared. */
  async poll(accountId: string, endpointId: string) {
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint.accountId !== accountId) {
      throw new NotFoundException('Endpoint не належить цьому каналу.');
    }
    const { account, adapter } = await this.getAdapter(accountId);
    if (!adapter.listProvisionedAccounts) {
      throw new NotImplementedException('Адаптер не вміє перераховувати акаунти.');
    }

    const claimed = (await adapter.listProvisionedAccounts(
      this.accountConfig(account),
    )) as ProvisionedAccount[];
    const cfg = (endpoint.configJson as Record<string, unknown>) ?? {};

    // 4 reconciliation strategies, in order of preference:
    //   1. endpoint.uuid matches a sidecar account → link that.
    //   2. endpoint.phoneE164 matches a sidecar account → link that.
    //   3. endpoint.deviceName matches a sidecar account → link that.
    //   4. exactly one account appeared since the wizard started → that's it.
    // Strategy 4 carries Signal: its account list is bare phone numbers, so
    // there is nothing on it that identifies our device by name.
    let match = claimed.find((a) => {
      if (endpoint.uuid && a.uuid && a.uuid === endpoint.uuid) return true;
      if (endpoint.phoneE164 && a.phoneE164 && a.phoneE164 === endpoint.phoneE164) return true;
      if (endpoint.deviceName && a.deviceName && a.deviceName === endpoint.deviceName) return true;
      return false;
    });

    if (!match && Array.isArray(cfg['knownAccountsBefore'])) {
      const before = new Set((cfg['knownAccountsBefore'] as unknown[]).map(String));
      const fresh = claimed.filter((a) => a.externalId && !before.has(a.externalId));
      // Only act on an unambiguous diff. Two concurrent wizards against the
      // same sidecar would otherwise link each other's numbers.
      if (fresh.length === 1) {
        match = fresh[0];
      } else if (fresh.length > 1) {
        this.logger.warn(
          `Endpoint ${endpoint.id}: ${fresh.length} new sidecar accounts since QR was minted; ` +
            'cannot attribute one to this wizard. Use reattach to pick manually.',
        );
      }
    }

    // Last resort: adopt an account the sidecar already had but that no
    // endpoint claims. signal-cli does not always surface a freshly linked
    // account in `/v1/accounts` straight away, so a scan can complete while
    // the wizard is still polling and only appear in a later snapshot — by
    // which point it is no longer "new" relative to the baseline. Restricting
    // this to genuinely unclaimed accounts means we can never steal a number
    // that belongs to another endpoint.
    if (!match && claimed.length > 0) {
      const claimedIds = claimed.map((a) => a.externalId).filter(Boolean) as string[];
      const taken = await this.prisma.endpoint.findMany({
        where: { accountId, externalId: { in: claimedIds }, NOT: { id: endpoint.id } },
        select: { externalId: true },
      });
      const takenSet = new Set(taken.map((t) => t.externalId));
      const orphans = claimed.filter((a) => a.externalId && !takenSet.has(a.externalId));
      if (orphans.length === 1) {
        this.logger.log(
          `Endpoint ${endpoint.id}: adopting unclaimed sidecar account ${orphans[0].externalId}`,
        );
        match = orphans[0];
      }
    }

    if (match) {
      const updated = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          registrationState: RegistrationState.linked,
          uuid: match.uuid ?? endpoint.uuid,
          phoneE164: match.phoneE164 ?? endpoint.phoneE164,
          externalId: match.externalId ?? endpoint.externalId,
          registeredAt: new Date(),
          enabled: true,
          configJson: {} as never, // clear the QR session blob
        },
      });
      await this.audit.log(
        null,
        'endpoint.provision.linked',
        'endpoint',
        endpoint.id,
        { state: endpoint.registrationState },
        { phoneE164: match.phoneE164, uuid: match.uuid },
      );
      return { state: updated.registrationState, endpoint: updated };
    }

    // No match: if the QR has expired, mark failed.
    const expiresAt = cfg['qrExpiresAt'] ? new Date(String(cfg['qrExpiresAt'])) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      const updated = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: { registrationState: RegistrationState.failed },
      });
      return { state: updated.registrationState, endpoint: updated };
    }

    return { state: endpoint.registrationState, endpoint };
  }

  /**
   * Stream back the QR image a sidecar rendered for this endpoint.
   *
   * The sidecar lives on the `internal: true` transports network, so its own
   * image URL is unreachable from the admin's browser. The API is the only
   * process that can see both sides.
   */
  async qrImage(accountId: string, endpointId: string) {
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint.accountId !== accountId) {
      throw new NotFoundException('Endpoint не належить цьому каналу.');
    }
    const cfg = (endpoint.configJson as Record<string, unknown>) ?? {};
    const imageUrl = cfg['qrImageUrl'] ? String(cfg['qrImageUrl']) : '';
    if (!imageUrl) {
      throw new NotFoundException('Для цього endpoint немає QR-зображення.');
    }
    const { account, adapter } = await this.getAdapter(accountId);
    if (!adapter.fetchProvisioningImage) {
      throw new NotImplementedException('Адаптер не віддає QR-зображення.');
    }
    try {
      return await adapter.fetchProvisioningImage(this.accountConfig(account), imageUrl);
    } catch (err) {
      this.mapError(err);
    }
  }

  /** List what the sidecar currently has — wizard reconciliation. */
  async listSidecarAccounts(accountId: string) {
    const { account, adapter } = await this.getAdapter(accountId);
    if (!adapter.listProvisionedAccounts) {
      throw new NotImplementedException('Адаптер не вміє перераховувати акаунти.');
    }
    const accounts = await adapter.listProvisionedAccounts(this.accountConfig(account));
    return { accounts };
  }

  /** Submit an SMS/voice verification code. */
  async verify(accountId: string, endpointId: string, dto: ProvisionVerifyDto, actorId: string | null) {
    const { account, adapter } = await this.getAdapter(accountId);
    if (!adapter.verifyCode) {
      throw new NotImplementedException('Адаптер не підтримує SMS-код.');
    }
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint.accountId !== accountId) {
      throw new NotFoundException('Endpoint не належить цьому каналу.');
    }
    const phone = endpoint.phoneE164 ?? endpoint.externalId ?? '';
    if (!phone) {
      throw new BadRequestException('Endpoint не має номера для верифікації.');
    }

    await this.prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { registrationState: RegistrationState.verifying },
    });

    try {
      const result = await adapter.verifyCode(this.accountConfig(account), {
        phoneE164: phone,
        code: dto.code,
        token: dto.token,
      });
      if (!result.verified) {
        await this.prisma.endpoint.update({
          where: { id: endpoint.id },
          data: { registrationState: RegistrationState.failed },
        });
        return result;
      }
      // Verified — promote to `linked` and persist what the sidecar returned.
      const linked = result.account;
      const updated = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          registrationState: RegistrationState.linked,
          uuid: linked?.uuid ?? endpoint.uuid,
          phoneE164: linked?.phoneE164 ?? endpoint.phoneE164,
          externalId: linked?.externalId ?? endpoint.externalId,
          deviceName: linked?.deviceName ?? endpoint.deviceName,
          registeredAt: new Date(),
          enabled: true,
        },
      });
      await this.audit.log(
        actorId,
        'endpoint.provision.verified',
        'endpoint',
        endpoint.id,
        {},
        { phoneE164: linked?.phoneE164, uuid: linked?.uuid },
      );
      return { verified: true, account: linked, endpoint: updated };
    } catch (err) {
      await this.audit.log(
        actorId,
        'endpoint.provision.verify_failed',
        'endpoint',
        endpoint.id,
        {},
        { error: (err as Error).message },
      );
      this.mapError(err);
    }
  }

  /** Detach a phone from the sidecar and clear our row. */
  async unlink(endpointId: string, actorId: string | null) {
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint.registrationState !== RegistrationState.linked) {
      throw new ConflictException(
        'Цей endpoint не привʼязаний до акаунта у транспорті.',
      );
    }
    if (!endpoint.externalId) {
      throw new ConflictException('Endpoint не має externalId для відвʼязки.');
    }
    const { account, adapter } = await this.getAdapter(endpoint.accountId);
    if (!adapter.unlink) {
      throw new NotImplementedException('Адаптер не вміє відвʼязувати акаунти.');
    }

    await adapter.unlink(this.accountConfig(account), endpoint.externalId);
    const updated = await this.prisma.endpoint.update({
      where: { id: endpoint.id },
      data: {
        registrationState: RegistrationState.unpaired,
        uuid: null,
        phoneE164: null,
        externalId: null,
        registeredAt: null,
        deviceName: null,
        enabled: false,
      },
    });
    await this.audit.log(
      actorId,
      'endpoint.provision.unlinked',
      'endpoint',
      endpoint.id,
      { uuid: endpoint.uuid, phoneE164: endpoint.phoneE164 },
      { state: 'unpaired' },
    );
    return { ok: true, endpoint: updated };
  }

  /** Re-attach a phone that exists on the sidecar but lacks our row. */
  async reattach(
    accountId: string,
    endpointId: string,
    sidecarExternalId: string,
    actorId: string | null,
  ) {
    const { account, adapter } = await this.getAdapter(accountId);
    if (!adapter.listProvisionedAccounts) {
      throw new NotImplementedException('Адаптер не вміє перераховувати акаунти.');
    }
    const claimed = await adapter.listProvisionedAccounts(this.accountConfig(account));
    const match = (claimed as ProvisionedAccount[]).find(
      (a) => a.externalId === sidecarExternalId,
    );
    if (!match) {
      throw new NotFoundException('Акаунт не знайдено на транспорті.');
    }
    const endpoint = await this.getEndpoint(endpointId);
    if (endpoint.accountId !== accountId) {
      throw new NotFoundException('Endpoint не належить цьому каналу.');
    }
    const updated = await this.prisma.endpoint.update({
      where: { id: endpoint.id },
      data: {
        registrationState: RegistrationState.linked,
        uuid: match.uuid,
        phoneE164: match.phoneE164,
        externalId: match.externalId,
        registeredAt: new Date(),
        enabled: true,
      },
    });
    await this.audit.log(
      actorId,
      'endpoint.provision.reattached',
      'endpoint',
      endpoint.id,
      {},
      { phoneE164: match.phoneE164, uuid: match.uuid },
    );
    return updated;
  }
}