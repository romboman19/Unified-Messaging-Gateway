import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RotateCcw, XCircle } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Message, MessageStatus, ListResponse } from '../lib/types';
import {
  Badge,
  CHANNEL_LABEL,
  DIRECTION_COLOR,
  DIRECTION_LABEL,
  MESSAGE_STATUS_COLOR,
  MESSAGE_STATUS_LABEL,
} from '../components/ui';
import { apiError, formatDate, prettyJson, shortId } from '../lib/format';

const STATUS_OPTIONS: { value: '' | MessageStatus; label: string }[] = [
  { value: '', label: 'Усі статуси' },
  { value: 'scheduled', label: 'Заплановано' },
  { value: 'queued', label: 'В черзі' },
  { value: 'sent', label: 'Надіслано' },
  { value: 'delivered', label: 'Доставлено' },
  { value: 'read', label: 'Прочитано' },
  { value: 'failed', label: 'Помилка' },
  { value: 'cancelled', label: 'Скасовано' },
];

export default function MessagesPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [direction, setDirection] = useState('');
  const [q, setQ] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [actionError, setActionError] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['messages', { status, channel, direction, q }],
    queryFn: async () =>
      (
        await api.get<ListResponse<Message>>('/messages', {
          params: {
            limit: 100,
            ...(status && { status }),
            ...(channel && { channel }),
            ...(direction && { direction }),
            ...(q && { q }),
          },
        })
      ).data,
  });

  const retry = useMutation({
    mutationFn: async (id: string) => (await api.post(`/messages/${id}/retry`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages'] }),
    onError: (err) => setActionError(apiError(err, 'Не вдалося повторити відправку.')),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => (await api.post(`/messages/${id}/cancel`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messages'] }),
    onError: (err) => setActionError(apiError(err, 'Не вдалося скасувати повідомлення.')),
  });

  return (
    <div>
      <h2 className="text-2xl font-bold">Повідомлення</h2>
      <p className="mt-2 text-slate-500">Технічний журнал усіх повідомлень.</p>

      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-lg bg-white p-4 shadow">
        <div>
          <label className="block text-xs font-medium text-slate-500">Статус</label>
          <select
            className="mt-1 rounded border p-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500">Канал</label>
          <select
            className="mt-1 rounded border p-2 text-sm"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="">Усі канали</option>
            <option value="sms">SMS</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="signal">Signal</option>
            <option value="mock">Тестовий (mock)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500">Напрямок</label>
          <select
            className="mt-1 rounded border p-2 text-sm"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            <option value="">Обидва</option>
            <option value="inbound">Вхідні</option>
            <option value="outbound">Вихідні</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500">Пошук</label>
          <input
            className="mt-1 w-full rounded border p-2 text-sm"
            placeholder="ID, зовнішній ID або номер…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {actionError && (
        <div className="mt-4 rounded bg-red-100 p-3 text-sm text-red-700">{actionError}</div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow">
        {isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
        {isError && <div className="p-8 text-red-600">Не вдалося завантажити повідомлення.</div>}
        {data && data.items.length === 0 && (
          <div className="p-8 text-slate-500">Повідомлень не знайдено.</div>
        )}
        {data && data.items.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="p-3"></th>
                <th className="p-3">ID</th>
                <th className="p-3">Зовн. ID</th>
                <th className="p-3">Канал</th>
                <th className="p-3">Напрямок</th>
                <th className="p-3">Отримувач</th>
                <th className="p-3">Тип</th>
                <th className="p-3">Статус</th>
                <th className="p-3">Спроби</th>
                <th className="p-3">Створено</th>
                <th className="p-3">Дії</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <Fragment key={m.id}>
                  <tr className="border-b hover:bg-slate-50">
                    <td className="p-3">
                      <button
                        onClick={() => {
                          setExpandedId(expandedId === m.id ? null : m.id);
                          setShowRaw(false);
                        }}
                        className="rounded p-1 hover:bg-slate-200"
                        title="Перегляд"
                      >
                        {expandedId === m.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                    <td className="p-3 font-mono text-xs">{shortId(m.id)}</td>
                    <td className="p-3 font-mono text-xs">{m.externalId ?? '—'}</td>
                    <td className="p-3">{CHANNEL_LABEL[m.channelType]}</td>
                    <td className="p-3">
                      <Badge color={DIRECTION_COLOR[m.direction]}>{DIRECTION_LABEL[m.direction]}</Badge>
                    </td>
                    <td className="p-3">{m.toJson?.e164 ?? m.toJson?.raw ?? '—'}</td>
                    <td className="p-3">{m.messageType}</td>
                    <td className="p-3">
                      <Badge color={MESSAGE_STATUS_COLOR[m.status]}>
                        {MESSAGE_STATUS_LABEL[m.status]}
                      </Badge>
                    </td>
                    <td className="p-3">{m.attempts?.length ?? 0}</td>
                    <td className="p-3 whitespace-nowrap">{formatDate(m.createdAt)}</td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        {(m.status === 'failed' || m.status === 'cancelled') && (
                          <button
                            onClick={() => {
                              setActionError('');
                              retry.mutate(m.id);
                            }}
                            disabled={retry.isPending}
                            className="rounded border p-1.5 hover:bg-slate-100 disabled:opacity-50"
                            title="Повторити відправку"
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                        {(m.status === 'scheduled' || m.status === 'queued') && (
                          <button
                            onClick={() => {
                              setActionError('');
                              cancel.mutate(m.id);
                            }}
                            disabled={cancel.isPending}
                            className="rounded border p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-50"
                            title="Скасувати"
                          >
                            <XCircle size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === m.id && (
                    <tr className="border-b bg-slate-50">
                      <td colSpan={11} className="p-4">
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                          <div className="rounded border bg-white p-3">
                            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                              Текст
                            </div>
                            <div className="whitespace-pre-wrap text-sm">
                              {m.contentJson?.text || '—'}
                            </div>
                          </div>
                          <div className="rounded border bg-white p-3">
                            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                              Історія статусів
                            </div>
                            {(!m.statusHistory || m.statusHistory.length === 0) && (
                              <div className="text-sm text-slate-500">Немає записів.</div>
                            )}
                            <ul className="space-y-1 text-sm">
                              {m.statusHistory
                                ?.slice()
                                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                                .map((h) => (
                                  <li key={h.id} className="flex items-center gap-2">
                                    <Badge color={MESSAGE_STATUS_COLOR[h.status]}>
                                      {MESSAGE_STATUS_LABEL[h.status]}
                                    </Badge>
                                    <span className="text-slate-500">{h.source}</span>
                                    <span className="text-xs text-slate-400">
                                      {formatDate(h.createdAt)}
                                    </span>
                                  </li>
                                ))}
                            </ul>
                          </div>
                          <div className="rounded border bg-white p-3">
                            <div className="mb-2 text-xs font-semibold uppercase text-slate-500">
                              Спроби відправки
                            </div>
                            {(!m.attempts || m.attempts.length === 0) && (
                              <div className="text-sm text-slate-500">Спроб ще не було.</div>
                            )}
                            <ul className="space-y-1 text-sm">
                              {m.attempts?.map((a) => (
                                <li key={a.id} className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium">#{a.attemptNo}</span>
                                  <Badge
                                    color={
                                      a.result === 'success'
                                        ? 'bg-green-100 text-green-700'
                                        : 'bg-red-100 text-red-700'
                                    }
                                  >
                                    {a.result}
                                  </Badge>
                                  <span className="text-xs text-slate-400">
                                    {formatDate(a.startedAt)}
                                    {a.finishedAt ? ` → ${formatDate(a.finishedAt)}` : ''}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="rounded border bg-white p-3">
                            <div className="mb-2 flex items-center justify-between">
                              <div className="text-xs font-semibold uppercase text-slate-500">
                                JSON
                              </div>
                              <button
                                onClick={() => setShowRaw(!showRaw)}
                                className="rounded border px-2 py-1 text-xs hover:bg-slate-100"
                              >
                                {showRaw ? 'Сховати' : 'Показати сирий JSON'}
                              </button>
                            </div>
                            {showRaw && (
                              <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
                                {prettyJson(m)}
                              </pre>
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
