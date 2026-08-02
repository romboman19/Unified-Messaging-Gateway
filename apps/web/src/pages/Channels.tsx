import { useEffect, useState } from 'react';
import { api } from '../hooks/useAuth';
import {
  Trash2,
  Radio,
  Power,
  PowerOff,
  Link2,
  Unlink,
} from 'lucide-react';
import type {
  Endpoint,
  RegistrationState,
  TransportAccount,
} from '../lib/types';
import { ProvisioningWizard } from '../components/ProvisioningWizard';
import { apiError, formatDate } from '../lib/format';

type EndpointDraft = {
  label: string;
  externalId: string;
  phone: string;
};

const typeLabel: Record<TransportAccount['type'], string> = {
  sms: 'SMS / DBLtek GoIP',
  whatsapp: 'WhatsApp / UnoAPI або go-whatsapp-web-multidevice',
  signal: 'Signal / signal-cli-rest-api',
  mock: 'Mock (dev only)',
};

const emptyDraft = (): EndpointDraft => ({ label: '', externalId: '', phone: '' });

// Per-channel UI badges for registration state (TZ §1038).
const registrationBadge: Record<RegistrationState, { label: string; cls: string }> = {
  unpaired: { label: 'не прив\'язано', cls: 'bg-slate-100 text-slate-600' },
  qr_pending: { label: 'чекає QR...', cls: 'bg-amber-100 text-amber-700' },
  qr_displayed: { label: 'QR на екрані', cls: 'bg-amber-100 text-amber-700' },
  sms_pending: { label: 'чекає SMS...', cls: 'bg-amber-100 text-amber-700' },
  verifying: { label: 'перевірка коду', cls: 'bg-amber-100 text-amber-700' },
  linked: { label: 'прив\'язано', cls: 'bg-green-100 text-green-700' },
  relink_needed: { label: 'потрібна повторна прив\'язка', cls: 'bg-orange-100 text-orange-700' },
  failed: { label: 'помилка', cls: 'bg-red-100 text-red-700' },
};

export default function ChannelsPage() {
  const [accounts, setAccounts] = useState<TransportAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, EndpointDraft>>({});
  const [wizardFor, setWizardFor] = useState<TransportAccount | null>(null);
  const [balanceBusy, setBalanceBusy] = useState<string | null>(null);
  const [balanceEditing, setBalanceEditing] = useState<string | null>(null);

  async function fetchAccounts() {
    try {
      const res = await api.get<TransportAccount[]>('/transport-accounts');
      setAccounts(res.data);
    } catch (err) {
      setError('Не вдалося завантажити канали.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchAccounts();
  }, []);

  async function toggleAccount(id: string, current: string) {
    const next = current === 'active' ? 'inactive' : 'active';
    try {
      await api.patch(`/transport-accounts/${id}`, { status: next });
      await fetchAccounts();
    } catch (err) {
      setError('Не вдалося змінити статус каналу.');
    }
  }

  async function createEndpoint(accountId: string) {
    const form = drafts[accountId] ?? emptyDraft();
    if (!form.label.trim()) {
      setError('Вкажіть назву endpoint.');
      return;
    }
    try {
      await api.post(`/transport-accounts/${accountId}/endpoints`, {
        label: form.label.trim(),
        externalId: form.externalId.trim() || undefined,
        phoneE164: form.phone.trim() || undefined,
        enabled: true,
      });
      setDrafts((prev) => ({ ...prev, [accountId]: emptyDraft() }));
      await fetchAccounts();
      setError('');
    } catch (err: any) {
      setError(
        err?.response?.data?.message?.toString() ||
          'Не вдалося додати endpoint. Перевірте номер і спробуйте ще раз.',
      );
    }
  }

  async function checkBalance(ep: Endpoint) {
    setBalanceBusy(ep.id);
    setError('');
    try {
      await api.post(`/endpoints/${ep.id}/balance`);
      await fetchAccounts();
    } catch (err) {
      setError(apiError(err, 'Не вдалося перевірити баланс.'));
    } finally {
      setBalanceBusy(null);
    }
  }

  async function saveBalanceSettings(ep: Endpoint, ussd: string, threshold: string) {
    setError('');
    try {
      await api.patch(`/endpoints/${ep.id}`, {
        config: {
          ...(ep.configJson ?? {}),
          balanceUssd: ussd.trim(),
          lowBalanceThreshold: Number(threshold) || 0,
        },
      });
      await fetchAccounts();
      setBalanceEditing(null);
    } catch (err) {
      setError(apiError(err, 'Не вдалося зберегти налаштування балансу.'));
    }
  }

  async function deleteEndpoint(id: string) {
    if (!confirm('Видалити номер?')) return;
    try {
      await api.delete(`/endpoints/${id}`);
      await fetchAccounts();
      return;
    } catch (err) {
      // The API refuses by default when the number still carries history, and
      // says how much. Show that instead of a blanket failure, and let the
      // admin decide — silently swallowing it is what made delete look broken.
      const status = (err as { response?: { status?: number } })?.response?.status;
      const message = apiError(err, 'Не вдалося видалити номер.');
      if (status !== 409) {
        setError(message);
        return;
      }
      if (!confirm(`${message}\n\nВидалити номер разом з історією?`)) {
        setError('');
        return;
      }
      try {
        await api.delete(`/endpoints/${id}?force=true`);
        await fetchAccounts();
        setError('');
      } catch (forceErr) {
        setError(apiError(forceErr, 'Не вдалося видалити номер разом з історією.'));
      }
    }
  }

  async function toggleEndpoint(id: string, enabled: boolean) {
    try {
      await api.patch(`/endpoints/${id}`, { enabled: !enabled });
      await fetchAccounts();
    } catch (err) {
      setError('Не вдалося змінити статус endpoint.');
    }
  }

  async function unlinkEndpoint(id: string) {
    if (!confirm('Відв\'язати пристрій від цього каналу?')) return;
    try {
      await api.delete(`/endpoints/${id}/registration`);
      await fetchAccounts();
    } catch (err) {
      setError('Не вдалося відв\'язати пристрій.');
    }
  }

  function updateDraft(accountId: string, patch: Partial<EndpointDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [accountId]: { ...(prev[accountId] ?? emptyDraft()), ...patch },
    }));
  }

  // Channels that can be linked at runtime via QR. SMS uses physical SIMs,
  // so provisioning is not supported there (TZ §21 / capabilities).
  function canProvision(acc: TransportAccount): boolean {
    return acc.type === 'signal' || acc.type === 'whatsapp';
  }

  if (loading) return <div className="p-8">Завантаження...</div>;

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold">Канали</h2>
      <p className="mt-2 text-slate-500">
        Три транспортних канали вже налаштовані. Signal та WhatsApp підтримують прив'язку
        нового номера через QR-код прямо в інтерфейсі — натисніть «Прив'язати номер».
        Для SMS додавайте лінії вручну.
      </p>

      {error && (
        <div className="mb-4 mt-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>
      )}

      <section className="mt-6 space-y-4">
        {accounts.length === 0 && (
          <div className="rounded-lg bg-white p-6 text-center text-slate-500 shadow">
            Канали ще не завантажені. Зачекайте кілька секунд після старту API.
          </div>
        )}
        {accounts.map((acc) => {
          const isActive = acc.status === 'active';
          return (
            <div key={acc.id} className="rounded-lg bg-white p-4 shadow">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Radio size={20} className="text-slate-500" />
                  <div>
                    <div className="font-semibold">{acc.name}</div>
                    <div className="text-sm text-slate-500">
                      {typeLabel[acc.type] ?? acc.type} ·{' '}
                      <span className={isActive ? 'text-green-600' : 'text-slate-400'}>
                        {isActive ? 'активний' : 'вимкнений'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {canProvision(acc) && (
                    <button
                      onClick={() => setWizardFor(acc)}
                      className="flex items-center gap-1 rounded bg-blue-600 px-3 py-2 text-white hover:bg-blue-700"
                      title="Прив'язати новий номер через QR"
                    >
                      <Link2 size={16} /> Прив'язати номер
                    </button>
                  )}
                  <button
                    onClick={() => toggleAccount(acc.id, acc.status)}
                    className="rounded border p-2 hover:bg-slate-100"
                    title={isActive ? 'Вимкнути канал' : 'Увімкнути канал'}
                  >
                    {isActive ? <PowerOff size={16} /> : <Power size={16} />}
                  </button>
                </div>
              </div>

              {acc.endpoints.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-sm font-medium">Номери / лінії</h4>
                  <div className="space-y-2">
                    {acc.endpoints.map((ep) => {
                      const regState: RegistrationState =
                        ep.registrationState ?? 'unpaired';
                      const badge = registrationBadge[regState];
                      return (
                        <div key={ep.id} className="rounded border p-2">
                        <div
                          className="flex items-center justify-between"
                        >
                          <div className="text-sm">
                            <span className="font-medium">{ep.label}</span>
                            {ep.externalId && (
                              <span className="ml-2 text-slate-400">лінія {ep.externalId}</span>
                            )}
                            {ep.phoneE164 && (
                              <span className="ml-2 text-slate-400">{ep.phoneE164}</span>
                            )}{' '}
                            <span className={ep.enabled ? 'text-green-600' : 'text-slate-400'}>
                              · {ep.enabled ? 'увімкнений' : 'вимкнений'}
                            </span>
                            {canProvision(acc) && (
                              <>
                                {' · '}
                                <span
                                  className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}
                                  title={
                                    ep.deviceName ? `device: ${ep.deviceName}` : regState
                                  }
                                >
                                  {badge.label}
                                </span>
                              </>
                            )}
                          </div>
                          <div className="flex gap-2">
                            {canProvision(acc) && regState === 'linked' && (
                              <button
                                onClick={() => unlinkEndpoint(ep.id)}
                                className="flex items-center gap-1 rounded border p-1 text-orange-600 hover:bg-orange-50"
                                title="Відв'язати пристрій від каналу"
                              >
                                <Unlink size={14} /> Відв'язати
                              </button>
                            )}
                            {canProvision(acc) && (regState === 'qr_pending' || regState === 'qr_displayed') && (
                              <button
                                onClick={() => setWizardFor(acc)}
                                className="flex items-center gap-1 rounded border p-1 text-blue-600 hover:bg-blue-50"
                                title="Показати QR ще раз"
                              >
                                <Link2 size={14} /> QR
                              </button>
                            )}
                            {acc.type === 'sms' && (
                              <button
                                onClick={() => toggleEndpoint(ep.id, ep.enabled)}
                                className="rounded border p-1 hover:bg-slate-100"
                                title={ep.enabled ? 'Вимкнути' : 'Увімкнути'}
                              >
                                {ep.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                              </button>
                            )}
                            <button
                              onClick={() => deleteEndpoint(ep.id)}
                              className="rounded border p-1 text-red-600 hover:bg-red-50"
                              title="Видалити"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {acc.type === 'sms' && (
                          <BalanceCell
                            ep={ep}
                            busy={balanceBusy === ep.id}
                            editing={balanceEditing === ep.id}
                            onCheck={() => checkBalance(ep)}
                            onEdit={() => setBalanceEditing(ep.id)}
                            onCancel={() => setBalanceEditing(null)}
                            onSave={(u, t) => saveBalanceSettings(ep, u, t)}
                          />
                        )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* SMS keeps the manual endpoint form. Signal/WhatsApp use the
                  wizard exclusively — see ProvisioningWizard. */}
              {acc.type === 'sms' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void createEndpoint(acc.id);
                  }}
                  className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-7"
                >
                  <div className="md:col-span-3">
                    <input
                      className="w-full rounded border p-2"
                      placeholder="Назва (наприклад: Основна SIM)"
                      value={drafts[acc.id]?.label ?? ''}
                      onChange={(e) => updateDraft(acc.id, { label: e.target.value })}
                      required
                    />
                  </div>
                  <div className="md:col-span-2">
                    <input
                      className="w-full rounded border p-2"
                      placeholder="ID лінії GoIP (1..4)"
                      value={drafts[acc.id]?.externalId ?? ''}
                      onChange={(e) => updateDraft(acc.id, { externalId: e.target.value })}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <input
                      className="w-full rounded border p-2"
                      placeholder="+380XXXXXXXXX"
                      value={drafts[acc.id]?.phone ?? ''}
                      onChange={(e) => updateDraft(acc.id, { phone: e.target.value })}
                    />
                  </div>
                  <button
                    type="submit"
                    className="flex items-center justify-center gap-1 rounded bg-blue-600 py-2 text-white hover:bg-blue-700"
                    title="Додати endpoint"
                  >
                    Додати
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </section>

      {wizardFor && (
        <ProvisioningWizard
          account={wizardFor}
          onClose={() => setWizardFor(null)}
          onLinked={() => {
            void fetchAccounts();
          }}
        />
      )}
    </div>
  );
}
/**
 * Balance for one SIM: the last reading, when it was taken, and the controls
 * to take a new one or change the USSD code.
 *
 * A negative amount is a debt — carriers report it as a positive number next
 * to the word "заборгованість", so showing the sign is the only way an admin
 * can tell 48 owed from 48 available.
 */
function BalanceCell({
  ep,
  busy,
  editing,
  onCheck,
  onEdit,
  onCancel,
  onSave,
}: {
  ep: Endpoint;
  busy: boolean;
  editing: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (ussd: string, threshold: string) => void;
}) {
  const cfg = ep.configJson ?? {};
  const [ussd, setUssd] = useState(cfg.balanceUssd ?? '');
  const [threshold, setThreshold] = useState(String(cfg.lowBalanceThreshold ?? 20));

  const amount = typeof cfg.balance === 'number' ? cfg.balance : null;
  const limit = typeof cfg.lowBalanceThreshold === 'number' ? cfg.lowBalanceThreshold : 20;
  const low = amount !== null && amount < limit;

  if (editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2 text-xs">
        <label className="text-slate-500">USSD-код</label>
        <input
          className="w-28 rounded border p-1"
          value={ussd}
          onChange={(e) => setUssd(e.target.value)}
          placeholder="*111#"
        />
        <label className="text-slate-500">поріг</label>
        <input
          className="w-16 rounded border p-1"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
        <button
          onClick={() => onSave(ussd, threshold)}
          className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700"
        >
          Зберегти
        </button>
        <button onClick={onCancel} className="rounded border px-2 py-1 hover:bg-slate-100">
          Скасувати
        </button>
        <span className="text-slate-400">
          Київстар *111#, Vodafone *101#, Vodafone контракт *110*10#, lifecell *103#
        </span>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">Баланс:</span>
      {amount === null ? (
        <span className="text-slate-400">невідомий</span>
      ) : (
        <span
          className={`rounded px-1.5 py-0.5 font-medium ${
            amount < 0
              ? 'bg-red-100 text-red-700'
              : low
                ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700'
          }`}
          title={cfg.balanceReply ?? ''}
        >
          {amount} {cfg.balanceCurrency ?? ''}
          {amount < 0 ? ' (борг)' : ''}
        </span>
      )}
      {cfg.balanceCheckedAt && (
        <span className="text-slate-400">{formatDate(cfg.balanceCheckedAt)}</span>
      )}
      <button
        onClick={onCheck}
        disabled={busy}
        className="rounded border px-2 py-0.5 hover:bg-slate-100 disabled:opacity-50"
      >
        {busy ? 'Перевіряю…' : 'Перевірити'}
      </button>
      <button onClick={onEdit} className="text-blue-600 hover:underline">
        {cfg.balanceUssd ? `код ${cfg.balanceUssd}` : 'задати код'}
      </button>
    </div>
  );
}
