import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, AlertCircle } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Conversation, ListResponse, Message, TransportAccount } from '../lib/types';
import { Badge, CHANNEL_LABEL, MESSAGE_STATUS_LABEL } from '../components/ui';
import { apiError, formatDate, formatTime } from '../lib/format';

export default function TestChatPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState('mock');
  const [endpointId, setEndpointId] = useState('');
  const [to, setTo] = useState('');
  const [sendError, setSendError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: async () => (await api.get<ListResponse<Conversation>>('/conversations')).data,
    refetchInterval: 5000,
  });

  const messages = useQuery({
    queryKey: ['conversation-messages', selectedId],
    queryFn: async () =>
      (await api.get<ListResponse<Message>>(`/conversations/${selectedId}/messages`)).data,
    enabled: !!selectedId,
    refetchInterval: 3000,
  });

  const accounts = useQuery({
    queryKey: ['transport-accounts'],
    queryFn: async () => (await api.get<TransportAccount[]>('/transport-accounts')).data,
  });

  const send = useMutation({
    mutationFn: async () => {
      const account = accounts.data?.find((a) => a.type === channel);
      return (
        await api.post('/messages/ui-send', {
          channel,
          accountId: account?.id,
          endpointId: endpointId || undefined,
          to,
          type: 'text',
          content: { text },
        })
      ).data;
    },
    onSuccess: () => {
      setText('');
      setSendError('');
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['conversation-messages', selectedId] });
    },
    onError: (err) => {
      setSendError(apiError(err, 'Не вдалося надіслати повідомлення.'));
    },
  });

  const selected = conversations.data?.items.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.data?.items.length]);

  useEffect(() => {
    if (selected?.peerPhoneE164 && !to) setTo(selected.peerPhoneE164);
  }, [selectedId]);

  const activeAccounts = accounts.data?.filter((a) => a.status === 'active') ?? [];
  const channelAccounts = activeAccounts.filter((a) => a.type === channel);
  const channelEndpoints = channelAccounts.flatMap((a) =>
    a.endpoints.map((e) => ({ ...e, account: a })),
  );
  const hasRealAdapter = channel !== 'mock' && channelAccounts.length > 0;

  return (
    <div>
      <h2 className="text-2xl font-bold">Тест-чат</h2>
      <p className="mt-2 text-slate-500">
        Діагностика: перевірка відправки/отримання, статусів і медіа.
      </p>

      {hasRealAdapter && (
        <div className="mb-4 mt-4 flex items-start gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            Канал {channel} має активний акаунт, але реальний адаптер ще не реалізований.
            Відправка фактично пройде через заглушку (mock). Справжнє підключення з QR-кодом
            буде реалізовано в наступних milestone'ах.
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg bg-white shadow lg:col-span-1">
          <div className="border-b p-3 text-sm font-semibold">Розмови</div>
          <div className="max-h-[70vh] overflow-y-auto">
            {conversations.isLoading && <div className="p-4 text-sm text-slate-500">Завантаження...</div>}
            {conversations.isError && (
              <div className="p-4 text-sm text-red-600">Не вдалося завантажити розмови.</div>
            )}
            {conversations.data?.items.length === 0 && (
              <div className="p-4 text-sm text-slate-500">Розмов ще немає.</div>
            )}
            {conversations.data?.items.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`flex w-full items-start gap-3 border-b p-3 text-left hover:bg-slate-50 ${
                  selectedId === c.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
                  {(c.peerPhoneE164 ?? c.peerId ?? '?').slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-medium">
                      {c.peerPhoneE164 ?? c.peerId ?? '—'}
                    </div>
                    <div className="shrink-0 text-xs text-slate-400">
                      {formatTime(c.lastMessageAt)}
                    </div>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <Badge
                      color={
                        c.channelType === 'mock'
                          ? 'bg-purple-100 text-purple-700'
                          : 'bg-slate-100 text-slate-600'
                      }
                    >
                      {CHANNEL_LABEL[c.channelType]}
                    </Badge>
                    <span className="truncate text-xs text-slate-400">
                      {c.endpointLabel ?? ''}
                    </span>
                  </div>
                  {c.lastMessage && (
                    <div className="mt-1 truncate text-xs text-slate-500">
                      {c.lastMessage.direction === 'outbound' ? '↗ ' : '↙ '}
                      {c.lastMessage.preview || `[${c.lastMessage.messageType}]`}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col rounded-lg bg-white shadow lg:col-span-2">
          {!selected && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-slate-400">
              <MessageSquare size={40} />
              <div>Оберіть розмову ліворуч</div>
            </div>
          )}
          {selected && (
            <>
              <div className="flex items-center justify-between border-b p-3">
                <div>
                  <div className="font-semibold">
                    {selected.peerPhoneE164 ?? selected.peerId ?? '—'}
                  </div>
                  <div className="text-xs text-slate-500">
                    {CHANNEL_LABEL[selected.channelType]} · {selected.endpointLabel ?? '—'}
                  </div>
                </div>
                {selected.channelType === 'mock' && (
                  <Badge color="bg-purple-100 text-purple-700">Тестовий (mock)</Badge>
                )}
              </div>

              <div className="max-h-[55vh] flex-1 overflow-y-auto p-4">
                {messages.isLoading && <div className="text-sm text-slate-500">Завантаження...</div>}
                {messages.isError && (
                  <div className="text-sm text-red-600">Не вдалося завантажити повідомлення.</div>
                )}
                <div className="space-y-3">
                  {messages.data?.items.map((m) => (
                    <div
                      key={m.id}
                      className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                          m.direction === 'outbound'
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-100 text-slate-800'
                        }`}
                      >
                        <div className="whitespace-pre-wrap">
                          {m.contentJson?.text || `[${m.messageType}]`}
                        </div>
                        <div
                          className={`mt-1 flex items-center justify-end gap-2 text-xs ${
                            m.direction === 'outbound' ? 'text-blue-100' : 'text-slate-400'
                          }`}
                        >
                          <span>{formatDate(m.createdAt)}</span>
                          {m.direction === 'outbound' && (
                            <span>
                              {MESSAGE_STATUS_LABEL[m.status]}
                              {m.attemptsCount && m.attemptsCount > 0
                                ? ` · спроб: ${m.attemptsCount}`
                                : ''}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              </div>

              <div className="border-t p-3">
                {sendError && (
                  <div className="mb-2 rounded bg-red-100 p-2 text-xs text-red-700">{sendError}</div>
                )}
                <div className="mb-2 flex flex-wrap gap-2">
                  <select
                    className="rounded border p-2 text-sm"
                    value={channel}
                    onChange={(e) => {
                      setChannel(e.target.value);
                      setEndpointId('');
                    }}
                    title="Канал відправки"
                  >
                    <option value="mock">Тестовий (mock)</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="signal">Signal</option>
                  </select>
                  <select
                    className="rounded border p-2 text-sm"
                    value={endpointId}
                    onChange={(e) => setEndpointId(e.target.value)}
                    title="Endpoint"
                  >
                    <option value="">Авто (перший endpoint)</option>
                    {channelEndpoints.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.account.name} — {e.label}
                      </option>
                    ))}
                  </select>
                  <input
                    className="flex-1 rounded border p-2 text-sm"
                    placeholder="Номер отримувача (+380…)"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!text.trim() || !to.trim()) return;
                    send.mutate();
                  }}
                  className="flex gap-2"
                >
                  <input
                    className="flex-1 rounded border p-2 text-sm"
                    placeholder="Текст повідомлення…"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <button
                    type="submit"
                    disabled={send.isPending || !text.trim() || !to.trim()}
                    className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Send size={16} />
                    Надіслати
                  </button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
