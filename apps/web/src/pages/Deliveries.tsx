import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Delivery, DeliveryStatus, ListResponse } from '../lib/types';
import { Badge, DELIVERY_STATUS_COLOR, DELIVERY_STATUS_LABEL } from '../components/ui';
import { apiError, formatDate, prettyJson } from '../lib/format';

const TABS: { key: '' | DeliveryStatus; label: string }[] = [
  { key: '', label: 'Усі' },
  { key: 'pending', label: 'Очікує' },
  { key: 'delivered', label: 'Доставлено' },
  { key: 'failed', label: 'Помилка' },
  { key: 'dlq', label: 'DLQ' },
];

const REPLAYABLE: DeliveryStatus[] = ['failed', 'dlq', 'delivered'];

export default function DeliveriesPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'' | DeliveryStatus>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['deliveries', { status }],
    queryFn: async () =>
      (
        await api.get<ListResponse<Delivery>>('/deliveries', {
          params: { limit: 100, ...(status && { status }) },
        })
      ).data,
  });

  const replay = useMutation({
    mutationFn: async (id: string) => (await api.post(`/deliveries/${id}/replay`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deliveries'] }),
    onError: (err) => setActionError(apiError(err, 'Не вдалося повторити доставку.')),
  });

  return (
    <div>
      <h2 className="text-2xl font-bold">Доставки вебхуків</h2>
      <p className="mt-2 text-slate-500">Черга та історія доставок подій до призначень.</p>

      <div className="mt-6 flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`border-b-2 px-4 py-2 text-sm ${
              status === t.key
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
        {isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
        {isError && <div className="p-8 text-red-600">Не вдалося завантажити доставки.</div>}
        {data && data.items.length === 0 && (
          <div className="p-8 text-slate-500">Доставок не знайдено.</div>
        )}
        {data && data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="p-3"></th>
                <th className="p-3">Подія</th>
                <th className="p-3">Призначення</th>
                <th className="p-3">Статус</th>
                <th className="p-3">Спроби</th>
                <th className="p-3">Код відповіді</th>
                <th className="p-3">Тривалість</th>
                <th className="p-3">Наступна спроба</th>
                <th className="p-3">Створено</th>
                <th className="p-3">Дії</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d) => (
                <Fragment key={d.id}>
                  <tr className="border-b hover:bg-slate-50">
                    <td className="p-3">
                      <button
                        onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                        className="rounded p-1 hover:bg-slate-200"
                        title="Перегляд"
                      >
                        {expandedId === d.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                    <td className="p-3">
                      <Badge color="bg-blue-50 text-blue-700">{d.event?.eventType ?? '—'}</Badge>
                    </td>
                    <td className="p-3">{d.destination?.name ?? '—'}</td>
                    <td className="p-3">
                      <Badge color={DELIVERY_STATUS_COLOR[d.status]}>
                        {DELIVERY_STATUS_LABEL[d.status]}
                      </Badge>
                    </td>
                    <td className="p-3">
                      {d.attemptCount}/{d.maxAttempts}
                    </td>
                    <td className="p-3">{d.lastResponseCode ?? '—'}</td>
                    <td className="p-3">{d.durationMs != null ? `${d.durationMs} мс` : '—'}</td>
                    <td className="p-3 whitespace-nowrap">{formatDate(d.nextAttemptAt)}</td>
                    <td className="p-3 whitespace-nowrap">{formatDate(d.createdAt)}</td>
                    <td className="p-3">
                      {REPLAYABLE.includes(d.status) && (
                        <button
                          onClick={() => {
                            setActionError('');
                            replay.mutate(d.id);
                          }}
                          disabled={replay.isPending}
                          className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                          title="Повторити доставку"
                        >
                          <RotateCcw size={13} />
                          Повторити
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedId === d.id && (
                    <tr className="border-b bg-slate-50">
                      <td colSpan={10} className="p-4">
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                          <div className="rounded border bg-white p-3">
                            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                              Запит (тіло та заголовки)
                            </div>
                            <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                              {prettyJson(d.requestJson)}
                            </pre>
                          </div>
                          <div className="space-y-4">
                            <div className="rounded border bg-white p-3">
                              <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                                Відповідь
                              </div>
                              <pre className="max-h-40 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                                {prettyJson(d.responseJson)}
                              </pre>
                            </div>
                            {d.lastError && (
                              <div className="rounded border border-red-200 bg-red-50 p-3">
                                <div className="mb-1 text-xs font-semibold uppercase text-red-600">
                                  Остання помилка
                                </div>
                                <div className="whitespace-pre-wrap text-sm text-red-700">
                                  {d.lastError}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data && (
        <div className="mt-2 text-xs text-slate-500">
          Показано {data.items.length} з {data.count}
        </div>
      )}
    </div>
  );
}
