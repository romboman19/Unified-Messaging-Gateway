import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient } from '@umg/database';
import type { AccountConfig } from '@umg/channel-sdk';
import { AdaptersRegistry } from '../adapters/adapters.registry';
import { AlertsService } from '../alerts/alerts.service';
import { EventsService } from '../events/events.service';

const SMS_ADAPTER = 'goip-vendor';

/** Below this the SIM is treated as needing a top-up. Overridable per endpoint. */
const DEFAULT_LOW_BALANCE = 20;

/**
 * Daily prepaid-balance check for every SMS line (TZ §21).
 *
 * The USSD code differs per carrier and per tariff — Kyivstar answers `*111#`,
 * Vodafone prepaid `*101#`, Vodafone contract `*110*10#` — so it is configured
 * on the endpoint rather than guessed. A line without a code is skipped
 * silently: not every SIM is prepaid, and nagging about it daily would be
 * noise.
 *
 * Results land in `Endpoint.configJson` instead of a new column, which keeps
 * this out of a migration. A negative balance is a debt, not an error, and is
 * reported as such.
 */
@Injectable()
export class SmsBalanceScheduler {
  private readonly logger = new Logger(SmsBalanceScheduler.name);

  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    private readonly adapters: AdaptersRegistry,
    private readonly alerts: AlertsService,
    private readonly events: EventsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async checkAll(): Promise<void> {
    const account = await this.prisma.transportAccount.findFirst({
      where: { adapter: SMS_ADAPTER, status: 'active' },
    });
    if (!account) return;

    const adapter = this.adapters.get(SMS_ADAPTER) as any;
    if (typeof adapter?.checkBalance !== 'function') {
      this.logger.error(`Adapter ${SMS_ADAPTER} cannot check balances`);
      return;
    }

    const endpoints = await this.prisma.endpoint.findMany({
      where: { accountId: account.id, enabled: true },
    });
    if (endpoints.length === 0) return;

    const accountConfig: AccountConfig = {
      id: account.id,
      adapter: account.adapter,
      configJson: (account.encryptedConfig as Record<string, unknown>) ?? {},
    };

    for (const endpoint of endpoints) {
      const cfg = (endpoint.configJson as Record<string, unknown>) ?? {};
      // Per-SIM code first; an account-wide default covers a fleet on one
      // carrier without repeating it on every line.
      const code =
        (typeof cfg['balanceUssd'] === 'string' && cfg['balanceUssd']) ||
        (typeof accountConfig.configJson['balanceUssd'] === 'string' &&
          (accountConfig.configJson['balanceUssd'] as string)) ||
        '';
      const line = endpoint.externalId;
      if (!code || !line) continue;

      try {
        const result = await adapter.checkBalance(accountConfig, line, code);
        await this.record(endpoint.id, cfg, result);

        if (!result.ok) {
          this.logger.warn(`Balance check failed for ${line}: ${result.reply}`);
          await this.emit('sim.ussd.failed', account.id, endpoint.id, {
            line,
            phone: endpoint.phoneE164,
            error: result.reply,
          });
          continue;
        }
        this.logger.log(
          `${line}: ${result.amount ?? '?'} ${result.currency ?? ''} — ${result.reply.slice(0, 80)}`,
        );

        if (result.amount === null) {
          // The carrier answered but in a shape we could not read. Worth
          // surfacing once: the code may be wrong for this tariff.
          await this.alerts.raise({
            fingerprint: `sms.balance.unparsed:${endpoint.id}`,
            ruleKey: 'sms.balance.unparsed',
            severity: 'info',
            title: `Не вдалося розібрати баланс лінії ${line}`,
            message: `Оператор відповів: ${result.reply}`,
            payload: { endpointId: endpoint.id, line, reply: result.reply },
          });
          continue;
        }

        const threshold =
          typeof cfg['lowBalanceThreshold'] === 'number'
            ? (cfg['lowBalanceThreshold'] as number)
            : DEFAULT_LOW_BALANCE;

        // Every successful reading is routable, so a CRM can track balances
        // without polling us.
        await this.emit('sim.balance.updated', account.id, endpoint.id, {
          line,
          phone: endpoint.phoneE164,
          amount: result.amount,
          currency: result.currency,
          threshold,
          reply: result.reply,
        });

        // A recovery is worth its own event: whoever was told about the low
        // balance needs telling when it is no longer low.
        const wasLow = cfg['balance'] !== undefined && Number(cfg['balance']) < threshold;
        if (wasLow && result.amount >= threshold) {
          await this.emit('sim.balance.recovered', account.id, endpoint.id, {
            line,
            phone: endpoint.phoneE164,
            amount: result.amount,
            currency: result.currency,
            threshold,
          });
        }

        if (result.amount < threshold) {
          await this.emit('sim.balance.low', account.id, endpoint.id, {
            line,
            phone: endpoint.phoneE164,
            amount: result.amount,
            currency: result.currency,
            threshold,
            inDebt: result.amount < 0,
            reply: result.reply,
          });
          const inDebt = result.amount < 0;
          await this.alerts.raise({
            fingerprint: `sms.balance.low:${endpoint.id}`,
            ruleKey: 'sms.balance.low',
            severity: inDebt ? 'critical' : 'warning',
            title: inDebt
              ? `Заборгованість на SIM ${endpoint.phoneE164 ?? line}`
              : `Низький баланс SIM ${endpoint.phoneE164 ?? line}`,
            message: `${result.amount} ${result.currency ?? ''} (поріг ${threshold}). Відповідь оператора: ${result.reply}`,
            payload: {
              endpointId: endpoint.id,
              line,
              amount: result.amount,
              currency: result.currency,
              threshold,
            },
          });
        }
      } catch (err) {
        this.logger.error(`Balance check for ${line} threw: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Emits a routable event. Alerts show up in the UI; events are what routing
   * rules can forward to a webhook, so a low balance reaches the CRM without
   * anyone watching the alerts page.
   */
  private async emit(
    type: string,
    accountId: string,
    endpointId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.emit({
        type,
        aggregateId: endpointId,
        channel: 'sms' as never,
        accountId,
        endpointId,
        data: { sim: data },
      });
    } catch (err) {
      // A failed event must not lose the balance reading itself.
      this.logger.error(`Could not emit ${type}: ${(err as Error).message}`);
    }
  }

  private async record(
    endpointId: string,
    cfg: Record<string, unknown>,
    result: { ok: boolean; amount: number | null; currency: string | null; reply: string },
  ): Promise<void> {
    await this.prisma.endpoint.update({
      where: { id: endpointId },
      data: {
        configJson: {
          ...cfg,
          balance: result.amount,
          balanceCurrency: result.currency,
          balanceReply: result.reply,
          balanceCheckedAt: new Date().toISOString(),
          balanceOk: result.ok,
        } as never,
      },
    });
  }
}
