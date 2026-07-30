import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Alert, AlertRule, ListResponse } from '../lib/types';
import { Badge, SEVERITY_COLOR, SEVERITY_LABEL } from '../components/ui';
import { apiError, formatDate } from '../lib/format';

export default function AlertsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'firing' | 'resolved'>('firing');
  const [actionError, setActionError] = useState('');

  const alerts = useQuery({
    queryKey: ['alerts', tab],
    queryFn: async () =>
      (await api.get<ListResponse<Alert>>('/alerts', { params: { status: tab, limit: 100 } })).data,
  });

  const rules = useQuery({
    queryKey: ['alert-rules'],
    queryFn: async () => (await api.get<ListResponse<AlertRule>>('/alert-rules')).data,
  });

  const resolve = useMutation({
    mutationFn: async (id: string) => (await api.post(`/alerts/${id}/resolve`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (err) => setActionError(apiError(err, 'Не вдалося вирішити сповіщення.')),
  });

  const toggleRule = useMutation({
    mutationFn: async (rule: AlertRule) =>
      (await api.patch(`/alert-rules/${rule.key}`, { enabled: !rule.enabled })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alert-rules'] }),
  });

  return (
    <div>
      <h2 className="text-2xl font-bold">Сповіщення</h2>
      <p className="mt-2 text-slate-500">Алерти від правил моніторингу.</p>

      <div className="mt-6 flex gap-2 border-b">
        {(
          [
            { key: 'firing', label: 'Активні' },
            { key: 'resolved', label: 'Вирішені' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`border-b-2 px-4 py-2 text-sm ${
              tab === t.key
                ? 'border-blue-600 font-semibold text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="mt-4 rounded bg-red-100 p-3 text-sm text-red-700">{actionError}</div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow">
        {alerts.isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
        {alerts.isError && (
          <div className="p-8 text-red-600">Не вдалося завантажити сповіщення.</div>
        )}
        {alerts.data && alerts.data.items.length === 0 && (
          <div className="p-8 text-slate-500">Сповіщень немає.</div>
        )}
        {alerts.data && alerts.data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="p-3">Важливість</th>
                <th className="p-3">Заголовок</th>
                <th className="p-3">Повідомлення</th>
                <th className="p-3">Відбиток</th>
                <th className="p-3">Перший раз</th>
                <th className="p-3">Останній раз</th>
                {tab === 'firing' && <th className="p-3">Дії</th>}
              </tr>
            </thead>
            <tbody>
              {alerts.data.items.map((a) => (
                <tr key={a.id} className="border-b hover:bg-slate-50">
                  <td className="p-3">
                    <Badge color={SEVERITY_COLOR[a.severity] ?? 'bg-slate-100 text-slate-600'}>
                      {SEVERITY_LABEL[a.severity] ?? a.severity}
                    </Badge>
                  </td>
                  <td className="p-3 font-medium">{a.title}</td>
                  <td className="max-w-md p-3">
                    <div className="truncate" title={a.message}>
                      {a.message}
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-slate-500">{a.fingerprint}</td>
                  <td className="p-3 whitespace-nowrap">{formatDate(a.firstSeenAt)}</td>
                  <td className="p-3 whitespace-nowrap">{formatDate(a.lastSeenAt)}</td>
                  {tab === 'firing' && (
                    <td className="p-3">
                      <button
                        onClick={() => {
                          setActionError('');
                          resolve.mutate(a.id);
                        }}
                        disabled={resolve.isPending}
                        className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                      >
                        <CheckCircle2 size={13} />
                        Вирішено
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <section className="mt-8">
        <h3 className="mb-3 text-lg font-semibold">Правила сповіщень</h3>
        <div className="overflow-x-auto rounded-lg bg-white shadow">
          {rules.isLoading && <div className="p-6 text-slate-500">Завантаження...</div>}
          {rules.isError && <div className="p-6 text-red-600">Не вдалося завантажити правила.</div>}
          {rules.data && (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="p-3">Ключ</th>
                  <th className="p-3">Назва</th>
                  <th className="p-3">Стан</th>
                </tr>
              </thead>
              <tbody>
                {rules.data.items.map((r) => (
                  <tr key={r.key} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-mono text-xs">{r.key}</td>
                    <td className="p-3">{r.name}</td>
                    <td className="p-3">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          disabled={toggleRule.isPending}
                          onChange={() => toggleRule.mutate(r)}
                        />
                        <span className={r.enabled ? 'text-green-600' : 'text-slate-400'}>
                          {r.enabled ? 'увімкнено' : 'вимкнено'}
                        </span>
                      </label>
                    </td>
                  </tr>
                ))}
                {rules.data.items.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-6 text-slate-500">
                      Правил немає.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
