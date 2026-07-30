import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { ApiToken } from '../lib/types';
import { Badge, ConfirmDialog, Modal } from '../components/ui';
import { apiError, formatDate } from '../lib/format';

export default function ApiTokensPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const tokens = useQuery({
    queryKey: ['api-tokens'],
    queryFn: async () => (await api.get<ApiToken[]>('/api-tokens')).data,
  });

  const generate = useMutation({
    mutationFn: async (tokenName: string) =>
      (await api.post<{ token: string; name: string }>('/api-tokens', { name: tokenName || undefined })).data,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      setNewToken(data.token);
      setName('');
      setCopied(false);
    },
    onError: (err) => setError(apiError(err, 'Не вдалося згенерувати токен.')),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api-tokens/${id}`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
      setRevoking(null);
    },
    onError: (err) => setError(apiError(err, 'Не вдалося відкликати токен.')),
  });

  async function copyToken() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold">API</h2>
      <p className="mt-2 text-slate-500">Глобальні API-токени для програмного доступу.</p>

      {error && <div className="mt-4 rounded bg-red-100 p-3 text-sm text-red-700">{error}</div>}

      <div className="mt-6 rounded-lg bg-white p-4 shadow">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            generate.mutate(name.trim());
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="min-w-64 flex-1">
            <label className="block text-sm font-medium">Назва токена</label>
            <input
              className="mt-1 w-full rounded border p-2 text-sm"
              placeholder="Наприклад: CRM інтеграція"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={generate.isPending}
            className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Plus size={16} />
            Згенерувати токен
          </button>
        </form>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg bg-white shadow">
        {tokens.isLoading && <div className="p-8 text-slate-500">Завантаження...</div>}
        {tokens.isError && <div className="p-8 text-red-600">Не вдалося завантажити токени.</div>}
        {tokens.data && tokens.data.length === 0 && (
          <div className="p-8 text-slate-500">Токенів ще немає.</div>
        )}
        {tokens.data && tokens.data.length > 0 && (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="p-3">Назва</th>
                <th className="p-3">Створено</th>
                <th className="p-3">Останнє використання</th>
                <th className="p-3">Стан</th>
                <th className="p-3">Дії</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id} className="border-b hover:bg-slate-50">
                  <td className="p-3 font-medium">{t.name}</td>
                  <td className="p-3 whitespace-nowrap">{formatDate(t.createdAt)}</td>
                  <td className="p-3 whitespace-nowrap">{formatDate(t.lastUsedAt)}</td>
                  <td className="p-3">
                    {t.revokedAt ? (
                      <Badge color="bg-red-100 text-red-700">відкликано</Badge>
                    ) : (
                      <Badge color="bg-green-100 text-green-700">активний</Badge>
                    )}
                  </td>
                  <td className="p-3">
                    {!t.revokedAt && (
                      <button
                        onClick={() => setRevoking(t)}
                        className="rounded border p-2 text-red-600 hover:bg-red-50"
                        title="Відкликати"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <section className="mt-6 rounded-lg bg-white p-4 shadow">
        <h3 className="mb-3 flex items-center gap-2 font-semibold">
          <KeyRound size={18} />
          Використання API
        </h3>
        <p className="text-sm text-slate-600">Приклад запиту з токеном:</p>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
{`curl -X POST https://umg.example.com/api/v1/messages \\
  -H "Authorization: Bearer umg_..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: unique-key-123" \\
  -d '{"channel": "sms", "to": "+380501234567", "type": "text", "content": {"text": "Привіт"}}'`}
        </pre>
        <p className="mt-3 text-sm text-slate-600">
          Заголовок <code className="rounded bg-slate-100 px-1">Idempotency-Key</code> захищає від
          дублювання повідомлень: якщо повторити запит з тим самим ключем, сервер поверне результат
          першого запиту замість створення нового повідомлення. Рекомендується генерувати унікальний
          ключ для кожного логічного повідомлення.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Інтерактивна документація API:{' '}
          <a href="/api/docs" target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
            /api/docs
          </a>
        </p>
      </section>

      {newToken && (
        <Modal title="Новий токен згенеровано" onClose={() => setNewToken(null)}>
          <div className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Збережіть токен зараз — більше він не буде показано.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-slate-900 p-3 font-mono text-xs text-slate-100">
              {newToken}
            </code>
            <button
              onClick={copyToken}
              className="flex shrink-0 items-center gap-1 rounded border px-3 py-2 text-sm hover:bg-slate-100"
            >
              <Copy size={15} />
              {copied ? 'Скопійовано' : 'Копіювати'}
            </button>
          </div>
          <div className="mt-6 flex justify-end">
            <button
              onClick={() => setNewToken(null)}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              Готово
            </button>
          </div>
        </Modal>
      )}

      {revoking && (
        <ConfirmDialog
          text={`Відкликати токен «${revoking.name}»? Усі інтеграції, що його використовують, одразу втратять доступ.`}
          busy={revoke.isPending}
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke.mutate(revoking.id)}
        />
      )}
    </div>
  );
}
