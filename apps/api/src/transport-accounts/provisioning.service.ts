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

    // 1. Create the endpoint row up-front so the wizard can poll against
    //    a stable id even if the user closes the tab mid-flow.
    const endpoint = await this.prisma.endpoint.create({
      data: {
        accountId,
        label: dto.label,
        deviceName: dto.deviceName,
        externalId: dto.deviceName,
        phoneE164: dto.phoneE164 ?? null,
        registrationState: RegistrationState.qr_pending,
        enabled: false,
      },
    });

    try {
      const result: ProvisionQrResult = await adapter.provisionQr(
        this.accountConfig(account),
        { deviceName: dto.deviceName },
      );
      await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          registrationState: RegistrationState.qr_displayed,
          configJson: {
            qrSessionId: result.sessionId,
            qrExpiresAt: new Date(Date.now() + result.ttlSeconds * 1000).toISOString(),
          } as never,
        },
      });
      await this.audit.log(
        actorId,
        'endpoint.provision.qr_requested',
        'endpoint',
        endpoint.id,
        {},
        { deviceName: dto.deviceName, ttlSeconds: result.ttlSeconds },
      );
      return {
        endpointId: endpoint.id,
        uri: result.uri,
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

    const claimed = await adapter.listProvisionedAccounts(this.accountConfig(account));

    // 3 reconciliation strategies, in order of preference:
    //   1. endpoint.uuid matches a sidecar account → link that.
    //   2. endpoint.phoneE164 matches a sidecar account → link that.
    //   3. endpoint.deviceName matches a sidecar account → link that.
    const match = (claimed as ProvisionedAccount[]).find((a) => {
      if (endpoint.uuid && a.uuid && a.uuid === endpoint.uuid) return true;
      if (endpoint.phoneE164 && a.phoneE164 && a.phoneE164 === endpoint.phoneE164) return true;
      if (endpoint.deviceName && a.deviceName && a.deviceName === endpoint.deviceName) return true;
      return false;
    });

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
    const cfg = (endpoint.configJson as Record<string, unknown>) ?? {};
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
      }
      return result;
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