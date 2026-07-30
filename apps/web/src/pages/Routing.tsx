import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Globe, Mail, Pencil, Plus, ScrollText, Send, Trash2 } from 'lucide-react';
import { api } from '../hooks/useAuth';
import {
  ChannelType,
  Destination,
  DestinationType,
  ListResponse,
  RoutingRule,
  TransportAccount,
} from '../lib/types';
import { EVENT_TYPES } from '../lib/eventTypes';
import { Badge, CHANNEL_LABEL, ConfirmDialog, Modal } from '../components/ui';
import { apiError, shortId } from '../lib/format';

const TYPE_LABEL: Record<DestinationType, string> = {
  webhook: 'Webhook',
  email: 'Email',
  telegram: 'Telegram',
  internal_log: 'Внутрішній лог',
};

const TYPE_ICON: Record<DestinationType, typeof Globe> = {
  webhook: Globe,
  email: Mail,
  telegram: Send,
  internal_log: ScrollText,
};

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-green-500' : 'bg-slate-300'
      }`}
      title={checked ? 'Вимкнути' : 'Увімкнути'}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4.5 left-0.5' : 'left-0.5'
        }`}
        style={checked ? { transform: 'translateX(1rem)' } : undefined}
      />
    </button>
  );
}

interface RuleForm {
  name: string;
  priority: number;
  eventTypes: string[];
  channelType: '' | ChannelType;
  accountId: string;
  endpointId: string;
  fieldSelector: string;
  destinationIds: string[];
}

function emptyRuleForm(): RuleForm {
  return {
    name: '',
    priority: 100,
    eventTypes: [],
    channelType: '',
    accountId: '',
    endpointId: '',
    fieldSelector: '',
    destinationIds: [],
  };
}

interface DestForm {
  id: string | null;
  name: string;
  type: DestinationType;
  enabled: boolean;
  url: string;
  secret: string;
  recipients: string;
  botToken: string;
  chatId: string;
  timeoutMs: number;
  fieldSelector: string;
  templateJson: string;
}

function emptyDestForm(): DestForm {
  return {
    id: null,
    name: '',
    type: 'webhook',
    enabled: true,
    url: '',
    secret: '',
    recipients: '',
    botToken: '',
    chatId: '',
    timeoutMs: 10000,
    fieldSelector: '',
    templateJson: '',
  };
}

function destToForm(d: Destination): DestForm {
  const cfg = d.configJson ?? {};
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    enabled: d.enabled,
    url: d.url ?? '',
    secret: '',
    recipients: Array.isArray(cfg['recipients']) ? (cfg['recipients'] as string[]).join(', ') : '',
    botToken: '',
    chatId: typeof cfg['chatId'] === 'string' ? (cfg['chatId'] as string) : '',
    timeoutMs: d.timeoutMs ?? 10000,
    fieldSelector: (d.fieldSelector ?? []).join('\n'),
    templateJson: d.templateJson ? JSON.stringify(d.templateJson, null, 2) : '',
  };
}

interface TestResult {
  deliveryId?: string;
  status?: string;
  responseCode?: number | null;
  responseExcerpt?: string;
  durationMs?: number | null;
}

export default function RoutingPage() {
  const [tab, setTab] = useState<'rules' | 'destinations'>('rules');
  return (
    <div>
      <h2 className="text-2xl font-bold">Маршрутизація</h2>
      <p className="mt-2 text-slate-500">Правила маршрутизації подій до призначень.</p>
      <div className="mt-6 flex gap-2 border-b">
        {(
          [
            { key: 'rules', label: 'Правила' },
            { key: 'destinations', label: 'Призначення' },
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
      {tab === 'rules' ? <RulesTab /> : <DestinationsTab />}
    </div>
  );
}

function RulesTab() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RuleForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RoutingRule | null>(null);
  const [formError, setFormError] = useState('');

  const rules = useQuery({
    queryKey: ['routing-rules'],
    queryFn: async () => (await api.get<ListResponse<RoutingRule>>('/routing-rules')).data,
  });

  const destinations = useQuery({
    queryKey: ['destinations'],
    queryFn: async () => (await api.get<ListResponse<Destination>>('/destinations')).data,
  });

  const accounts = useQuery({
    queryKey: ['transport-accounts'],
    queryFn: async () => (await api.get<TransportAccount[]>('/transport-accounts')).data,
  });

  const save = useMutation({
    mutationFn: async (form: RuleForm) => {
      const body = {
        name: form.name,
        priority: form.priority,
        eventTypes: form.eventTypes,
        filters: {
          ...(form.channelType && { channelType: form.channelType }),
          ...(form.accountId && { accountId: form.accountId }),
          ...(form.endpointId && { endpointId: form.endpointId }),
        },
        fieldSelector: form.fieldSelector
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        destinationIds: form.destinationIds,
      };
      if (editingId) return (await api.patch(`/routing-rules/${editingId}`, body)).data;
      return (await api.post('/routing-rules', body)).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing-rules'] });
      setEditing(null);
      setEditingId(null);
    },
    onError: (err) => setFormError(apiError(err, 'Не вдалося зберегти правило.')),
  });

  const toggle = useMutation({
    mutationFn: async (rule: RoutingRule) =>
      (await api.patch(`/routing-rules/${rule.id}`, { enabled: !rule.enabled })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing-rules'] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/routing-rules/${id}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing-rules'] });
      setDeleting(null);
    },
  });

  const selectedAccount = accounts.data?.find((a) => a.id === editing?.accountId);

  return (
    <div className="mt-4">
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => {
            setEditing(emptyRuleForm());
            setEditingId(null);
            setFormError('');
          }}
          className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          <Plus size={16} /> Нове правило
        </button>
      </div>

      {rules.isLoading && <div className="p-4 text-slate-500">Завантаження...</div>}
      {rules.isError && <div className="p-4 text-red-600">Не вдалося завантажити правила.</div>}
      {rules.data?.items.length === 0 && (
        <div className="rounded-lg bg-white p-8 text-slate-500 shadow">Правил ще немає.</div>
      )}
      <div className="space-y-3">
        {rules.data?.items.map((r) => (
          <div key={r.id} className="rounded-lg bg-white p-4 shadow">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{r.name}</span>
                  <span className="text-xs text-slate-400">пріоритет: {r.priority}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.eventTypes.map((t) => (
                    <Badge key={t} color="bg-blue-50 text-blue-700">
                      {t}
                    </Badge>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.destinations.length === 0 && (
                    <span className="text-xs text-slate-400">Без призначень</span>
                  )}
                  {r.destinations.map((d) => (
                    <Badge key={d.id} color={d.enabled ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}>
                      {d.name}
                    </Badge>
                  ))}
                </div>
                {(r.filters?.channelType || r.filters?.accountId || r.filters?.endpointId) && (
                  <div className="mt-2 text-xs text-slate-500">
                    Фільтри:{' '}
                    {[
                      r.filters.channelType ? `канал ${CHANNEL_LABEL[r.filters.channelType as ChannelType]}` : '',
                      r.filters.accountId ? `акаунт ${shortId(r.filters.accountId)}` : '',
                      r.filters.endpointId ? `endpoint ${shortId(r.filters.endpointId)}` : '',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Toggle checked={r.enabled} onChange={() => toggle.mutate(r)} disabled={toggle.isPending} />
                <button
                  onClick={() => {
                    setEditingId(r.id);
                    setEditing({
                      name: r.name,
                      priority: r.priority,
                      eventTypes: r.eventTypes,
                      channelType: (r.filters?.channelType as ChannelType) ?? '',
                      accountId: r.filters?.accountId ?? '',
                      endpointId: r.filters?.endpointId ?? '',
                      fieldSelector: (r.fieldSelector ?? []).join('\n'),
                      destinationIds: r.destinations.map((d) => d.id),
                    });
                    setFormError('');
                  }}
                  className="rounded border p-2 hover:bg-slate-100"
                  title="Редагувати"
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => setDeleting(r)}
                  className="rounded border p-2 text-red-600 hover:bg-red-50"
                  title="Видалити"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal
          title={editingId ? 'Редагувати правило' : 'Нове правило'}
          onClose={() => {
            setEditing(null);
            setEditingId(null);
          }}
          wide
        >
          {formError && <div className="mb-3 rounded bg-red-100 p-2 text-sm text-red-700">{formError}</div>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">Назва</label>
              <input
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Пріоритет (менше = вище)</label>
              <input
                type="number"
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.priority}
                onChange={(e) => setEditing({ ...editing, priority: parseInt(e.target.value, 10) || 0 })}
              />
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium">Типи подій</label>
            <div className="mt-2 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded border p-2 md:grid-cols-3">
              {EVENT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={editing.eventTypes.includes(t)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        eventTypes: e.target.checked
                          ? [...editing.eventTypes, t]
                          : editing.eventTypes.filter((x) => x !== t),
                      })
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="block text-sm font-medium">Фільтр: канал</label>
              <select
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.channelType}
                onChange={(e) => setEditing({ ...editing, channelType: e.target.value as '' | ChannelType })}
              >
                <option value="">Будь-який</option>
                <option value="sms">SMS</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="signal">Signal</option>
                <option value="mock">Тестовий (mock)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium">Фільтр: акаунт</label>
              <select
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.accountId}
                onChange={(e) => setEditing({ ...editing, accountId: e.target.value, endpointId: '' })}
              >
                <option value="">Будь-який</option>
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium">Фільтр: endpoint</label>
              <select
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.endpointId}
                onChange={(e) => setEditing({ ...editing, endpointId: e.target.value })}
              >
                <option value="">Будь-який</option>
                {selectedAccount?.endpoints.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium">
              Призначення
            </label>
            <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded border p-2">
              {destinations.data?.items.length === 0 && (
                <div className="text-xs text-slate-500">Спочатку створіть призначення у вкладці «Призначення».</div>
              )}
              {destinations.data?.items.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.destinationIds.includes(d.id)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        destinationIds: e.target.checked
                          ? [...editing.destinationIds, d.id]
                          : editing.destinationIds.filter((x) => x !== d.id),
                      })
                    }
                  />
                  {d.name}
                  <span className="text-xs text-slate-400">({TYPE_LABEL[d.type]})</span>
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm font-medium">
              Селектор полів (один шлях на рядок; порожньо = усі)
            </label>
            <textarea
              className="mt-1 w-full rounded border p-2 font-mono text-xs"
              rows={3}
              value={editing.fieldSelector}
              onChange={(e) => setEditing({ ...editing, fieldSelector: e.target.value })}
              placeholder={'data.message\ndata.status'}
            />
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(null);
                setEditingId(null);
              }}
              className="rounded border px-4 py-2 text-sm hover:bg-slate-100"
            >
              Скасувати
            </button>
            <button
              onClick={() => save.mutate(editing)}
              disabled={save.isPending || !editing.name.trim() || editing.eventTypes.length === 0}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Зберегти
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          text={`Видалити правило «${deleting.name}»? Цю дію не можна скасувати.`}
          busy={del.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => del.mutate(deleting.id)}
        />
      )}
    </div>
  );
}

function DestinationsTab() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<DestForm | null>(null);
  const [deleting, setDeleting] = useState<Destination | null>(null);
  const [formError, setFormError] = useState('');
  const [testResults, setTestResults] = useState<Record<string, TestResult | { error: string }>>({});

  const destinations = useQuery({
    queryKey: ['destinations'],
    queryFn: async () => (await api.get<ListResponse<Destination>>('/destinations')).data,
  });

  const save = useMutation({
    mutationFn: async (form: DestForm) => {
      const fieldSelector = form.fieldSelector
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      let template: Record<string, unknown> | null | undefined;
      if (form.templateJson.trim()) {
        template = JSON.parse(form.templateJson) as Record<string, unknown>;
      } else if (form.id) {
        template = null;
      }
      const config: Record<string, unknown> =
        form.type === 'email'
          ? { recipients: form.recipients.split(',').map((s) => s.trim()).filter(Boolean) }
          : form.type === 'telegram'
            ? {
                ...(form.botToken && { botToken: form.botToken }),
                ...(form.chatId && { chatId: form.chatId }),
              }
            : {};
      const body: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        enabled: form.enabled,
        url: form.type === 'webhook' ? form.url || null : null,
        timeoutMs: form.timeoutMs,
        fieldSelector,
        config,
        ...(template !== undefined && { template }),
        ...(form.secret && { secret: form.secret }),
      };
      if (form.id) return (await api.patch(`/destinations/${form.id}`, body)).data;
      return (await api.post('/destinations', body)).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations'] });
      setEditing(null);
    },
    onError: (err) => {
      if (err instanceof SyntaxError) {
        setFormError('Некоректний JSON у шаблоні.');
      } else {
        setFormError(apiError(err, 'Не вдалося зберегти призначення.'));
      }
    },
  });

  const toggle = useMutation({
    mutationFn: async (d: Destination) =>
      (await api.patch(`/destinations/${d.id}`, { enabled: !d.enabled })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['destinations'] }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/destinations/${id}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['destinations'] });
      setDeleting(null);
    },
  });

  const test = useMutation({
    mutationFn: async (id: string) => (await api.post<TestResult>(`/destinations/${id}/test`, {})).data,
    onSuccess: (data, id) => setTestResults((prev) => ({ ...prev, [id]: data })),
    onError: (err, id) =>
      setTestResults((prev) => ({ ...prev, [id]: { error: apiError(err, 'Тест не вдався.') } })),
  });

  const summary = (d: Destination): string => {
    if (d.url) return d.url;
    const cfg = d.configJson ?? {};
    if (d.type === 'email' && Array.isArray(cfg['recipients'])) {
      return (cfg['recipients'] as string[]).join(', ');
    }
    if (d.type === 'telegram' && typeof cfg['chatId'] === 'string') {
      return `chatId: ${cfg['chatId']}`;
    }
    if (d.type === 'internal_log') return 'Запис у внутрішній лог';
    return '—';
  };

  return (
    <div className="mt-4">
      <div className="mb-4 flex justify-end">
        <button
          onClick={() => {
            setEditing(emptyDestForm());
            setFormError('');
          }}
          className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          <Plus size={16} /> Нове призначення
        </button>
      </div>

      {destinations.isLoading && <div className="p-4 text-slate-500">Завантаження...</div>}
      {destinations.isError && (
        <div className="p-4 text-red-600">Не вдалося завантажити призначення.</div>
      )}
      {destinations.data?.items.length === 0 && (
        <div className="rounded-lg bg-white p-8 text-slate-500 shadow">Призначень ще немає.</div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {destinations.data?.items.map((d) => {
          const Icon = TYPE_ICON[d.type];
          const result = testResults[d.id];
          return (
            <div key={d.id} className="rounded-lg bg-white p-4 shadow">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Icon size={22} className="mt-0.5 shrink-0 text-slate-500" />
                  <div className="min-w-0">
                    <div className="font-semibold">{d.name}</div>
                    <div className="text-xs text-slate-400">{TYPE_LABEL[d.type]}</div>
                    <div className="mt-1 truncate text-sm text-slate-600">{summary(d)}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      таймаут: {d.timeoutMs} мс
                      {d.hasSecret && ' · секрет збережено'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Toggle checked={d.enabled} onChange={() => toggle.mutate(d)} disabled={toggle.isPending} />
                  <button
                    onClick={() => {
                      setEditing(destToForm(d));
                      setFormError('');
                    }}
                    className="rounded border p-2 hover:bg-slate-100"
                    title="Редагувати"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    onClick={() => setDeleting(d)}
                    className="rounded border p-2 text-red-600 hover:bg-red-50"
                    title="Видалити"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={() => test.mutate(d.id)}
                  disabled={test.isPending}
                  className="flex items-center gap-1 rounded border px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
                >
                  <FlaskConical size={15} />
                  Тест
                </button>
                {result && (
                  <div className="min-w-0 flex-1 text-xs">
                    {'error' in result ? (
                      <span className="text-red-600">{result.error}</span>
                    ) : (
                      <span className="text-slate-600">
                        статус: <b>{result.status ?? '—'}</b>
                        {result.responseCode != null && ` · код: ${result.responseCode}`}
                        {result.durationMs != null && ` · ${result.durationMs} мс`}
                        {result.responseExcerpt && (
                          <div className="mt-1 truncate text-slate-400">{result.responseExcerpt}</div>
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <Modal
          title={editing.id ? 'Редагувати призначення' : 'Нове призначення'}
          onClose={() => setEditing(null)}
          wide
        >
          {formError && <div className="mb-3 rounded bg-red-100 p-2 text-sm text-red-700">{formError}</div>}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">Назва</label>
              <input
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Тип</label>
              <select
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.type}
                disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, type: e.target.value as DestinationType })}
              >
                <option value="webhook">Webhook</option>
                <option value="email">Email</option>
                <option value="telegram">Telegram</option>
                <option value="internal_log">Внутрішній лог</option>
              </select>
            </div>
          </div>

          {editing.type === 'webhook' && (
            <>
              <div className="mt-4">
                <label className="block text-sm font-medium">URL</label>
                <input
                  className="mt-1 w-full rounded border p-2 text-sm"
                  placeholder="https://example.com/hook"
                  value={editing.url}
                  onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                />
              </div>
              <div className="mt-4">
                <label className="block text-sm font-medium">Секрет (HMAC)</label>
                <input
                  type="password"
                  className="mt-1 w-full rounded border p-2 text-sm"
                  value={editing.secret}
                  onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                />
                {editing.id && (
                  <p className="mt-1 text-xs text-slate-400">Залиште порожнім, щоб не змінювати.</p>
                )}
              </div>
              <div className="mt-4">
                <label className="block text-sm font-medium">Шаблон (templateJson, JSON)</label>
                <textarea
                  className="mt-1 w-full rounded border p-2 font-mono text-xs"
                  rows={4}
                  value={editing.templateJson}
                  onChange={(e) => setEditing({ ...editing, templateJson: e.target.value })}
                  placeholder='{"event": "{{type}}"}'
                />
              </div>
            </>
          )}

          {editing.type === 'telegram' && (
            <>
              <div className="mt-4">
                <label className="block text-sm font-medium">Bot token</label>
                <input
                  type="password"
                  className="mt-1 w-full rounded border p-2 text-sm"
                  value={editing.botToken}
                  onChange={(e) => setEditing({ ...editing, botToken: e.target.value })}
                />
                {editing.id && (
                  <p className="mt-1 text-xs text-slate-400">Залиште порожнім, щоб не змінювати.</p>
                )}
              </div>
              <div className="mt-4">
                <label className="block text-sm font-medium">Chat ID</label>
                <input
                  className="mt-1 w-full rounded border p-2 text-sm"
                  value={editing.chatId}
                  onChange={(e) => setEditing({ ...editing, chatId: e.target.value })}
                />
              </div>
            </>
          )}

          {editing.type === 'email' && (
            <div className="mt-4">
              <label className="block text-sm font-medium">Отримувачі (через кому)</label>
              <input
                className="mt-1 w-full rounded border p-2 text-sm"
                placeholder="ops@example.com, admin@example.com"
                value={editing.recipients}
                onChange={(e) => setEditing({ ...editing, recipients: e.target.value })}
              />
            </div>
          )}

          {editing.type === 'internal_log' && (
            <p className="mt-4 text-sm text-slate-500">
              Для внутрішнього логу додаткових налаштувань немає.
            </p>
          )}

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">Таймаут, мс</label>
              <input
                type="number"
                className="mt-1 w-full rounded border p-2 text-sm"
                value={editing.timeoutMs}
                onChange={(e) => setEditing({ ...editing, timeoutMs: parseInt(e.target.value, 10) || 10000 })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Селектор полів (один на рядок)</label>
              <textarea
                className="mt-1 w-full rounded border p-2 font-mono text-xs"
                rows={2}
                value={editing.fieldSelector}
                onChange={(e) => setEditing({ ...editing, fieldSelector: e.target.value })}
              />
            </div>
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            Увімкнено
          </label>

          <div className="mt-6 flex justify-end gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded border px-4 py-2 text-sm hover:bg-slate-100"
            >
              Скасувати
            </button>
            <button
              onClick={() => save.mutate(editing)}
              disabled={save.isPending || !editing.name.trim()}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Зберегти
            </button>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          text={`Видалити призначення «${deleting.name}»? Правила, що на нього посилаються, втратять це призначення.`}
          busy={del.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => del.mutate(deleting.id)}
        />
      )}
    </div>
  );
}
