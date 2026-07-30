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
  type: 'sms' | 'whatsapp' | 'signal' | 'mock';
  adapter: string;
  status: string;
  endpoints: Endpoint[];
}

export default function ChannelsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [newAccount, setNewAccount] = useState({
    type: 'mock' as Account['type'],
    adapter: 'mock',
    name: '',
    status: 'active',
  });

  const [newEndpoint, setNewEndpoint] = useState<Record<string, { label: string; externalId: string; phone: string; enabled: boolean }>>({});

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

  async function createAccount(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/transport-accounts', {
        type: newAccount.type,
        adapter: newAccount.adapter,
        name: newAccount.name,
        status: newAccount.status,
        config: {},
      });
      setNewAccount({ type: 'mock', adapter: 'mock', name: '', status: 'active' });
      await fetchAccounts();
    } catch (err: any) {
      setError(err?.response?.data?.message?.toString() || 'Помилка створення акаунта.');
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm('Видалити акаунт і всі його endpoint?')) return;
    await api.delete(`/transport-accounts/${id}`);
    await fetchAccounts();
  }

  async function toggleAccount(id: string, current: string) {
    const next = current === 'active' ? 'disabled' : 'active';
    await api.patch(`/transport-accounts/${id}`, { status: next });
    await fetchAccounts();
  }

  async function createEndpoint(accountId: string) {
    const form = newEndpoint[accountId];
    if (!form?.label) return;
    await api.post(`/transport-accounts/${accountId}/endpoints`, {
      label: form.label,
      externalId: form.externalId,
      phoneE164: form.phone,
      enabled: form.enabled,
      config: {},
    });
    setNewEndpoint((prev) => ({ ...prev, [accountId]: { label: '', externalId: '', phone: '', enabled: true } }));
    await fetchAccounts();
  }

  async function deleteEndpoint(id: string) {
    if (!confirm('Видалити endpoint?')) return;
    await api.delete(`/endpoints/${id}`);
    await fetchAccounts();
  }

  async function toggleEndpoint(id: string, enabled: boolean) {
    await api.patch(`/endpoints/${id}`, { enabled: !enabled });
    await fetchAccounts();
  }

  const typeLabel: Record<Account['type'], string> = {
    sms: 'SMS / GoIP',
    whatsapp: 'WhatsApp',
    signal: 'Signal',
    mock: 'Mock',
  };

  if (loading) return <div className="p-8">Завантаження...</div>;

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold">Канали</h2>
      <p className="mt-2 text-slate-500">Керування транспортними акаунтами та endpoint.</p>

      {error && <div className="mb-4 mt-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      <section className="mt-6 rounded-lg bg-white p-4 shadow">
        <h3 className="mb-4 font-semibold">Додати акаунт</h3>
        <form onSubmit={createAccount} className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <div className="md:col-span-1">
            <label className="block text-sm font-medium">Тип</label>
            <select
              className="mt-1 w-full rounded border p-2"
              value={newAccount.type}
              onChange={(e) => {
                const t = e.target.value as Account['type'];
                setNewAccount((p) => ({ ...p, type: t, adapter: t }));
              }}
            >
              <option value="mock">Mock</option>
              <option value="sms">SMS / GoIP</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="signal">Signal</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium">Назва</label>
            <input
              className="mt-1 w-full rounded border p-2"
              value={newAccount.name}
              onChange={(e) => setNewAccount((p) => ({ ...p, name: e.target.value }))}
              placeholder="Наприклад: Основний GoIP"
              required
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-sm font-medium">Адаптер</label>
            <input
              className="mt-1 w-full rounded border p-2"
              value={newAccount.adapter}
              onChange={(e) => setNewAccount((p) => ({ ...p, adapter: e.target.value }))}
              placeholder="mock"
            />
          </div>
          <div className="md:col-span-1 flex items-end">
            <button type="submit" className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700">
              Додати
            </button>
          </div>
        </form>
      </section>

      <section className="mt-6 space-y-4">
        {accounts.length === 0 && <p className="text-slate-500">Ще немає акаунтів.</p>}
        {accounts.map((acc) => (
          <div key={acc.id} className="rounded-lg bg-white p-4 shadow">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <Radio size={20} className="text-slate-500" />
                <div>
                  <div className="font-semibold">{acc.name}</div>
                  <div className="text-sm text-slate-500">
                    {typeLabel[acc.type]} · {acc.adapter} · {' '}
                    <span
                      className={
                        acc.status === 'active' ? 'text-green-600' : 'text-slate-400'
                      }
                    >
                      {acc.status === 'active' ? 'активний' : 'вимкнений'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => toggleAccount(acc.id, acc.status)}
                  className="rounded border p-2 hover:bg-slate-100"
                  title={acc.status === 'active' ? 'Вимкнути' : 'Увімкнути'}
                >
                  {acc.status === 'active' ? <PowerOff size={16} /> : <Power size={16} />}
                </button>
                <button
                  onClick={() => deleteAccount(acc.id)}
                  className="rounded border p-2 text-red-600 hover:bg-red-50"
                  title="Видалити"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            {acc.endpoints.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 text-sm font-medium">Endpoint'и</h4>
                <div className="space-y-2">
                  {acc.endpoints.map((ep) => (
                    <div
                      key={ep.id}
                      className="flex items-center justify-between rounded border p-2"
                    >
                      <div className="text-sm">
                        {ep.label}
                        {ep.externalId && <span className="ml-2 text-slate-400">{ep.externalId}</span>}
                        {ep.phoneE164 && <span className="ml-2 text-slate-400">{ep.phoneE164}</span>}
                        {' '}
                        <span className={ep.enabled ? 'text-green-600' : 'text-slate-400'}>
                          {ep.enabled ? 'активний' : 'вимкнений'}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => toggleEndpoint(ep.id, ep.enabled)}
                          className="rounded border p-1 hover:bg-slate-100"
                        >
                          {ep.enabled ? <PowerOff size={14} /> : <Power size={14} />}
                        </button>
                        <button
                          onClick={() => deleteEndpoint(ep.id)}
                          className="rounded border p-1 text-red-600 hover:bg-red-50"
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
              className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-5"
            >
              <div className="md:col-span-2">
                <input
                  className="w-full rounded border p-2"
                  placeholder="Назва endpoint"
                  value={newEndpoint[acc.id]?.label || ''}
                  onChange={(e) =>
                    setNewEndpoint((prev) => ({
                      ...prev,
                      [acc.id]: { ...(prev[acc.id] || { externalId: '', phone: '', enabled: true }), label: e.target.value },
                    }))
                  }
                  required
                />
              </div>
              <div className="md:col-span-1">
                <input
                  className="w-full rounded border p-2"
                  placeholder="ID лінії / номер"
                  value={newEndpoint[acc.id]?.externalId || ''}
                  onChange={(e) =>
                    setNewEndpoint((prev) => ({
                      ...prev,
                      [acc.id]: { ...(prev[acc.id] || { label: '', phone: '', enabled: true }), externalId: e.target.value },
                    }))
                  }
                />
              </div>
              <div className="md:col-span-1">
                <input
                  className="w-full rounded border p-2"
                  placeholder="Телефон"
                  value={newEndpoint[acc.id]?.phone || ''}
                  onChange={(e) =>
                    setNewEndpoint((prev) => ({
                      ...prev,
                      [acc.id]: { ...(prev[acc.id] || { label: '', externalId: '', enabled: true }), phone: e.target.value },
                    }))
                  }
                />
              </div>
              <div className="md:col-span-1 flex items-center">
                <button type="submit" className="flex w-full items-center justify-center gap-1 rounded border py-2 hover:bg-slate-100">
                  <Plus size={16} /> Endpoint
                </button>
              </div>
            </form>
          </div>
        ))}
      </section>
    </div>
  );
}
