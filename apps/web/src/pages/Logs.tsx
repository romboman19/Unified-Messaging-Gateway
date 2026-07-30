import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { AuditLog, ListResponse, MessageEvent } from '../lib/types';
import { EVENT_TYPES } from '../lib/eventTypes';
import { Badge, CHANNEL_LABEL } from '../components/ui';
import { formatDate, prettyJson, shortId } from '../lib/format';

export default function LogsPage() {
  const [tab, setTab] = useState<'events' | 'audit'>('events');
  const [eventType, setEventType] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const events = useQuery({
    queryKey: ['events', eventType],
    queryFn: async () =>
      (
        await api.get<ListResponse<MessageEvent>>('/events', {
          params: { limit: 100, ...(eventType && { type: eventType }) },
        })
      ).data,
    enabled: tab === 'events',
  });

  const audit = useQuery({
    queryKey: ['audit-logs'],
    queryFn: async () =>
      (await api.get<ListResponse<AuditLog>>('/audit-logs', { params: { limit: 100 } })).data,
    enabled: tab === 'audit',
  });

  return (
    <div>
      <h2 className="text-2xl font-bold">Логи</h2>
      <p className="mt-2 text-slate-500">Події системи та журнал аудиту дій адміністраторів.</p>

      <div className="mt-6 flex gap-2 border-b">
        {(
          [
            { key: 'events', label: 'Події' },
            { key: 'audit', label: 'Аудит' },
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

      {tab === 'events' && (
        <>
          <div className="mt-4 flex items-end gap-3 rounded-lg bg-white p-4 shadow">
            <div>
              <label className="block text-xs font-medium text-slate-500">Тип події</label>
              <select
                className="mt-1 rounded border p-2 text-sm"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
              >
                <option value="">Усі події</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow">
            {events.isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
            {events.isError && <div className="p-8 text-red-600">Не вдалося завантажити події.</div>}
            {events.data && events.data.items.length === 0 && (
              <div className="p-8 text-slate-500">Подій не знайдено.</div>
            )}
            {events.data && events.data.items.length > 0 && (
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="p-3"></th>
                    <th className="p-3">Тип</th>
                    <th className="p-3">Канал</th>
                    <th className="p-3">Агрегат</th>
                    <th className="p-3">Час</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.items.map((ev) => (
                    <Fragment key={ev.id}>
                      <tr className="border-b hover:bg-slate-50">
                        <td className="p-3">
                          <button
                            onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                            className="rounded p-1 hover:bg-slate-200"
                            title="Тіло події"
                          >
                            {expandedId === ev.id ? (
                              <ChevronDown size={16} />
                            ) : (
                              <ChevronRight size={16} />
                            )}
                          </button>
                        </td>
                        <td className="p-3">
                          <Badge color="bg-blue-50 text-blue-700">{ev.eventType}</Badge>
                        </td>
                        <td className="p-3">{ev.channelType ? CHANNEL_LABEL[ev.channelType] : '—'}</td>
                        <td className="p-3 font-mono text-xs">{shortId(ev.aggregateId)}</td>
                        <td className="p-3 whitespace-nowrap">{formatDate(ev.createdAt)}</td>
                      </tr>
                      {expandedId === ev.id && (
                        <tr className="border-b bg-slate-50">
                          <td colSpan={5} className="p-4">
                            <pre className="max-h-72 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                              {prettyJson(ev.payload)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {events.data && (
            <div className="mt-2 text-xs text-slate-500">
              Показано {events.data.items.length} з {events.data.count}
            </div>
          )}
        </>
      )}

      {tab === 'audit' && (
        <>
          <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow">
            {audit.isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
            {audit.isError && <div className="p-8 text-red-600">Не вдалося завантажити аудит.</div>}
            {audit.data && audit.data.items.length === 0 && (
              <div className="p-8 text-slate-500">Записів аудиту немає.</div>
            )}
            {audit.data && audit.data.items.length > 0 && (
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="p-3">Користувач</th>
                    <th className="p-3">Дія</th>
                    <th className="p-3">Сутність</th>
                    <th className="p-3">ID сутності</th>
                    <th className="p-3">Час</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((a) => (
                    <tr key={a.id} className="border-b hover:bg-slate-50">
                      <td className="p-3 font-medium">{a.actor?.username ?? 'система'}</td>
                      <td className="p-3 font-mono text-xs">{a.action}</td>
                      <td className="p-3">{a.entityType}</td>
                      <td className="p-3 font-mono text-xs">{shortId(a.entityId)}</td>
                      <td className="p-3 whitespace-nowrap">{formatDate(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {audit.data && (
            <div className="mt-2 text-xs text-slate-500">
              Показано {audit.data.items.length} з {audit.data.count}
            </div>
          )}
        </>
      )}
    </div>
  );
}
