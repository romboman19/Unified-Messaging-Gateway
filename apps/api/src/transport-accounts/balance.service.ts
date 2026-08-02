import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChannelAdapterRegistry, type AccountConfig } from '@umg/channel-sdk';
import { registerBuiltinAdapters } from '@umg/adapters';
import { PrismaClient } from '@umg/database';

export interface BalanceResult {
  amount: number | null;
  currency: string | null;
  reply: string;
  checkedAt: string;
}

/**
 * On-demand SIM balance check (TZ §21).
 *
 * The daily scheduler in the worker keeps balances fresh, but an admin
 * topping a SIM up wants to see the new figure now, not tomorrow morning —
 * so the same check is exposed as an action.
 *
 * Only adapters that expose `checkBalance` support this; for the messenger
 * channels the notion does not exist.
 */
@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);
  private readonly registry: ChannelAdapterRegistry;

  constructor(@Inject('PRISMA') private readonly prisma: PrismaClient) {
    this.registry = registerBuiltinAdapters();
  }

  async check(endpointId: string, ussdOverride?: string): Promise<BalanceResult> {
    const endpoint = await this.prisma.endpoint.findUnique({ where: { id: endpointId } });
    if (!endpoint) throw new NotFoundException('Номер не знайдено.');

    const account = await this.prisma.transportAccount.findUnique({
      where: { id: endpoint.accountId },
    });
    if (!account) throw new NotFoundException('Канал не знайдено.');

    const adapter = this.registry.has(account.adapter)
      ? (this.registry.get(account.adapter) as any)
      : null;
    if (typeof adapter?.checkBalance !== 'function') {
      throw new BadRequestException('Цей канал не підтримує перевірку балансу.');
    }

    const cfg = (endpoint.configJson as Record<string, unknown>) ?? {};
    const accountCfg = (account.encryptedConfig as Record<string, unknown>) ?? {};
    const code =
      ussdOverride?.trim() ||
      (typeof cfg['balanceUssd'] === 'string' ? cfg['balanceUssd'] : '') ||
      (typeof accountCfg['balanceUssd'] === 'string' ? (accountCfg['balanceUssd'] as string) : '');
    if (!code) {
      throw new BadRequestException(
        'Не задано USSD-код балансу. Київстар — *111#, Vodafone — *101#, ' +
          'Vodafone контракт — *110*10#, lifecell — *103#.',
      );
    }
    if (!endpoint.externalId) {
      throw new BadRequestException('У номера не вказано ідентифікатор лінії.');
    }

    const accountConfig: AccountConfig = {
      id: account.id,
      adapter: account.adapter,
      configJson: accountCfg,
    };

    const result = await adapter.checkBalance(accountConfig, endpoint.externalId, code);
    if (!result.ok) {
      // The carrier's own words are more useful than anything we could invent.
      throw new BadGatewayException(result.reply || 'Не вдалося отримати баланс.');
    }

    const checkedAt = new Date().toISOString();
    await this.prisma.endpoint.update({
      where: { id: endpoint.id },
      data: {
        configJson: {
          ...cfg,
          // Remember the code that worked, so a one-off override becomes the
          // line's setting and the daily check uses it too.
          balanceUssd: code,
          balance: result.amount,
          balanceCurrency: result.currency,
          balanceReply: result.reply,
          balanceCheckedAt: checkedAt,
          balanceOk: true,
        } as never,
      },
    });

    this.logger.log(
      `Balance for ${endpoint.externalId}: ${result.amount ?? '?'} ${result.currency ?? ''}`,
    );
    return {
      amount: result.amount,
      currency: result.currency,
      reply: result.reply,
      checkedAt,
    };
  }
}
