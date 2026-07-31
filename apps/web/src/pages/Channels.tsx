import { useEffect, useState } from 'react';
import { api } from '../hooks/useAuth';
import { Trash2, Plus, Radio, Power, PowerOff } from 'lucide-react';

interface Endpoint {
  id: string;
  label: string;
  externalId: string | null;
  phoneE164: string | null;
  phoneRaw: string | null;
  enabled: boolean;
}

interface Account {
  id: string;
  name: string;
  type: 'sms' | 'whatsapp' | 'signal';
  adapter: string;
  status: string;
  endpoints: Endpoint[];
}

type EndpointDraft = {
  label: string;
  externalId: string;
  phone: string;
};

const typeLabel: Record<Account['type'], string> = {
  sms: 'SMS / DBLtek GoIP',
  whatsapp: 'WhatsApp / UnoAPI',
  signal: 'Signal / signal-cli-rest-api',
};

const emptyDraft = (): EndpointDraft => ({ label: '', externalId: '', phone: '' });

export default function ChannelsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, EndpointDraft>>({});

  async function fetchAccounts() {
    try {
      const res = await api.get('/transport-accounts');
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

  async function deleteEndpoint(id: string) {
    if (!confirm('Видалити endpoint?')) return;
    try {
      await api.delete(`/endpoints/${id}`);
      await fetchAccounts();
    } catch (err) {
      setError('Не вдалося видалити endpoint.');
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

  function updateDraft(accountId: string, patch: Partial<EndpointDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [accountId]: { ...(prev[accountId] ?? emptyDraft()), ...patch },
    }));
  }

  if (loading) return <div className="p-8">Завантаження...</div>;

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold">Канали</h2>
      <p className="mt-2 text-slate-500">
        Три транспортних канали вже налаштовані. Додавайте телефонні номери або SIM-лінії, з яких
        потрібно надсилати повідомлення.
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
                <button
                  onClick={() => toggleAccount(acc.id, acc.status)}
                  className="rounded border p-2 hover:bg-slate-100"
                  title={isActive ? 'Вимкнути канал' : 'Увімкнути канал'}
                >
                  {isActive ? <PowerOff size={16} /> : <Power size={16} />}
                </button>
              </div>

              {acc.endpoints.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-sm font-medium">Номери / лінії</h4>
                  <div className="space-y-2">
                    {acc.endpoints.map((ep) => (
                      <div
                        key={ep.id}
                        className="flex items-center justify-between rounded border p-2"
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
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => toggleEndpoint(ep.id, ep.enabled)}
                            className="rounded border p-1 hover:bg-slate-100"
                            title={ep.enabled ? 'Вимкнути' : 'Увімкнути'}
                          >
                            {ep.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                          </button>
                          <button
                            onClick={() => deleteEndpoint(ep.id)}
                            className="rounded border p-1 text-red-600 hover:bg-red-50"
                            title="Видалити"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                    placeholder={
                      acc.type === 'sms'
                        ? 'ID лінії GoIP (1..4)'
                        : acc.type === 'whatsapp'
                          ? 'ID в UnoAPI'
                          : 'ID пристрою Signal'
                    }
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
                  <Plus size={16} /> Додати
                </button>
              </form>
            </div>
          );
        })}
      </section>
    </div>
  );
}