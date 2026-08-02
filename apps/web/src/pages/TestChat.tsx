import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, Plus, AlertCircle, Paperclip } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Conversation, ListResponse, Message, TransportAccount } from '../lib/types';
import { Badge, CHANNEL_LABEL, MESSAGE_STATUS_LABEL } from '../components/ui';
import { apiError, formatDate, formatTime } from '../lib/format';

/** Channels the admin can pick from, in the order they appear in the picker. */
const CHANNELS = ['signal', 'whatsapp', 'sms', 'mock'] as const;

/** Human-friendly file size for attachment labels. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Turns an adapter's canonical failure code into something an admin can act
 * on. The transport's own wording ("Failed to send message") says nothing
 * about what to do next.
 */
function sendFailureReason(err: { code: string; message: string }): string {
  switch (err.code) {
    case 'RECIPIENT_NOT_REGISTERED':
      return 'Номер не зареєстрований у Signal — повідомлення туди надіслати неможливо.';
    case 'NO_RECIPIENT':
      return 'Не вказано отримувача.';
    case 'NETWORK_ERROR':
      return 'Транспорт недоступний. Спробуйте ще раз.';
    default:
      return err.message || 'Не вдалося надіслати.';
  }
}

export default function TestChatPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** True while composing a message to someone we have no conversation with. */
  const [composingNew, setComposingNew] = useState(false);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [to, setTo] = useState('');
  const [sendError, setSendError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const activeAccounts = useMemo(
    () => accounts.data?.filter((a) => a.status === 'active') ?? [],
    [accounts.data],
  );

  /** Channels that actually have a linked, enabled number behind them. */
  const usableChannels = useMemo(
    () =>
      CHANNELS.filter((c) =>
        activeAccounts.some((a) => a.type === c && a.endpoints.some((e) => e.enabled)),
      ),
    [activeAccounts],
  );

  // Default to the first channel with a linked number rather than to `mock`,
  // so the common case needs no fiddling with the picker.
  useEffect(() => {
    if (!channel && usableChannels.length > 0) setChannel(usableChannels[0]);
  }, [usableChannels, channel]);

  const channelEndpoints = useMemo(
    () =>
      activeAccounts
        .filter((a) => a.type === channel)
        .flatMap((a) => a.endpoints.filter((e) => e.enabled).map((e) => ({ ...e, account: a }))),
    [activeAccounts, channel],
  );

  const send = useMutation({
    mutationFn: async () => {
      const account =
        channelEndpoints.find((e) => e.id === endpointId)?.account ??
        activeAccounts.find((a) => a.type === channel);

      // Upload first: the send call references stored attachments by id, and
      // the worker reads their bytes back out of storage at dispatch time.
      let attachments: string[] | undefined;
      let type = 'text';
      if (file) {
        const form = new FormData();
        form.append('file', file);
        const uploaded = await api.post<{ id: string }>('/media', form, {
          // The axios instance defaults to application/json. Clearing it lets
          // the browser set multipart/form-data *with* its boundary, without
          // which the server cannot parse the upload.
          headers: { 'Content-Type': undefined },
        });
        attachments = [uploaded.data.id];
        type = file.type.startsWith('image/') ? 'image'
          : file.type.startsWith('video/') ? 'video'
          : file.type.startsWith('audio/') ? 'audio'
          : 'document';
      }

      return (
        await api.post('/messages/ui-send', {
          channel,
          accountId: account?.id,
          endpointId: endpointId || undefined,
          to,
          type,
          content: { text },
          attachments,
        })
      ).data;
    },
    onSuccess: () => {
      setText('');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSendError('');
      // A brand-new chat has no conversation row until the send lands, so
      // refresh the list and let the admin pick it up there.
      setComposingNew(false);
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

  // Opening a conversation targets its peer on its own channel.
  useEffect(() => {
    if (!selected) return;
    setTo(selected.peerPhoneE164 ?? '');
    setChannel(selected.channelType);
    setEndpointId('');
    setSendError('');
  }, [selectedId]);

  function startNewChat() {
    setSelectedId(null);
    setComposingNew(true);
    setTo('');
    setText('');
    setSendError('');
  }

  const canSend = (!!text.trim() || !!file) && !!to.trim() && !!channel && !send.isPending;

  const composer = (
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
          {usableChannels.length === 0 && <option value="">Немає привʼязаних номерів</option>}
          {usableChannels.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </option>
          ))}
        </select>
        <select
          className="rounded border p-2 text-sm"
          value={endpointId}
          onChange={(e) => setEndpointId(e.target.value)}
          title="З якого номера надсилати"
        >
          <option value="">Авто (перший номер)</option>
          {channelEndpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.phoneE164 ?? e.label} — {e.account.name}
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
      {file && (
        <div className="mb-2 flex items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs">
          <Paperclip size={14} />
          <span className="flex-1 truncate">
            {file.name} ({formatBytes(file.size)})
          </span>
          <button
            type="button"
            onClick={() => {
              setFile(null);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
            className="text-red-600 hover:underline"
          >
            прибрати
          </button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSend) return;
          send.mutate();
        }}
        className="flex gap-2"
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded border px-3 hover:bg-slate-100"
          title="Прикріпити файл"
        >
          <Paperclip size={16} />
        </button>
        <input
          className="flex-1 rounded border p-2 text-sm"
          placeholder={file ? 'Підпис до файлу (необовʼязково)…' : 'Текст повідомлення…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <Send size={16} />
          Надіслати
        </button>
      </form>
    </div>
  );

  return (
    <div>
      <h2 className="text-2xl font-bold">Тест-чат</h2>
      <p className="mt-2 text-slate-500">
        Діагностика: перевірка відправки/отримання, статусів і медіа.
      </p>

      {!accounts.isLoading && usableChannels.length === 0 && (
        <div className="mb-4 mt-4 flex items-start gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div>
            Немає жодного привʼязаного номера. Відкрийте «Канали» та привʼяжіть номер до Signal
            або WhatsApp — після цього тут зʼявиться можливість писати.
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg bg-white shadow lg:col-span-1">
          <div className="flex items-center justify-between border-b p-3">
            <span className="text-sm font-semibold">Розмови</span>
            <button
              onClick={startNewChat}
              disabled={usableChannels.length === 0}
              className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
              title="Написати на новий номер"
            >
              <Plus size={14} /> Нова
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {conversations.isLoading && <div className="p-4 text-sm text-slate-500">Завантаження...</div>}
            {conversations.isError && (
              <div className="p-4 text-sm text-red-600">Не вдалося завантажити розмови.</div>
            )}
            {conversations.data?.items.length === 0 && (
              <div className="p-4 text-sm text-slate-500">
                Розмов ще немає. Натисніть «Нова», щоб написати першому адресату.
              </div>
            )}
            {conversations.data?.items.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setComposingNew(false);
                  setSelectedId(c.id);
                }}
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
          {!selected && !composingNew && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-slate-400">
              <MessageSquare size={40} />
              <div>Оберіть розмову ліворуч</div>
              <button
                onClick={startNewChat}
                disabled={usableChannels.length === 0}
                className="flex items-center gap-1 rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Plus size={16} /> Написати на новий номер
              </button>
            </div>
          )}

          {composingNew && (
            <>
              <div className="border-b p-3">
                <div className="font-semibold">Нова розмова</div>
                <div className="text-xs text-slate-500">
                  Оберіть канал і номер, з якого писати, та введіть номер отримувача.
                </div>
              </div>
              <div className="flex-1 p-6 text-sm text-slate-400">
                Повідомлення зʼявиться в списку розмов після відправки.
              </div>
              {composer}
            </>
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
                        {m.attachments?.map((att) => (
                          <a
                            key={att.id}
                            href={`/api/v1/media/${att.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mb-1 block"
                            title={`${att.fileName} · ${formatBytes(att.sizeBytes)}`}
                          >
                            {att.mimeType.startsWith('image/') ? (
                              <img
                                src={`/api/v1/media/${att.id}`}
                                alt={att.fileName}
                                className="max-h-64 rounded"
                              />
                            ) : (
                              <span className="flex items-center gap-1 underline">
                                <Paperclip size={14} />
                                {att.fileName} ({formatBytes(att.sizeBytes)})
                              </span>
                            )}
                          </a>
                        ))}
                        {(m.contentJson?.text || !m.attachments?.length) && (
                          <div className="whitespace-pre-wrap">
                            {m.contentJson?.text || `[${m.messageType}]`}
                          </div>
                        )}
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
                        {m.direction === 'outbound' && m.status === 'failed' && m.lastError && (
                          <div className="mt-1 rounded bg-red-100 px-2 py-1 text-xs text-red-700">
                            {sendFailureReason(m.lastError)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
              </div>

              {composer}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
