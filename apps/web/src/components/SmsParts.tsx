import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../hooks/useAuth';
import { Message } from '../lib/types';
import { apiError, formatDate } from '../lib/format';

export function SmsParts({ message }: { message: Message }) {
  const [parts, setParts] = useState(message.smsParts ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const client = useQueryClient();
  const pending = message.status === 'assembling';
  const correct = async (split: boolean) => {
    if (split && !window.confirm('Розділити групу на окремі SMS у журналі? Уже створені пересилання залишаться без змін.')) return;
    setBusy(true); setError('');
    try {
      await api.post(`/messages/${message.id}/${split ? 'sms-split' : 'sms-order'}`,
        split ? {} : { partIds: parts.map((p) => p.id) });
      await client.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) { setError(apiError(err, 'Не вдалося виправити групу.')); }
    finally { setBusy(false); }
  };
  const move = (index: number, step: number) => {
    const next = [...parts];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setParts(next);
  };
  return <div className="rounded border bg-white p-3 lg:col-span-2">
    <h3 className="font-medium">Оригінальні частини SMS: {parts.length}</h3>
    <p className="my-2 text-xs text-slate-500">
      {pending ? 'Очікуємо наступні частини. Пересилання ще не створено.' :
        'Виправлення змінюють журнал. Уже створені пересилання залишаються без змін; повторного надсилання немає.'}
    </p>
    {message.metadataJson?.smsGrouping?.splitFrom && <p className="text-xs text-amber-700">
      Цю частину відокремлено вручну після створення пересилання.
    </p>}
    <ol className="space-y-2">
      {parts.map((part, index) => <li key={part.id} className="rounded border p-2">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>#{index + 1} · отримано {formatDate(part.arrivedAt)}</span>
          {!pending && parts.length > 1 && <>
            <button type="button" aria-label={`Частину ${index + 1} вгору`}
              disabled={busy || index === 0} onClick={() => move(index, -1)}
              className="rounded border px-2 py-1 disabled:opacity-30">↑</button>
            <button type="button" aria-label={`Частину ${index + 1} вниз`}
              disabled={busy || index === parts.length - 1} onClick={() => move(index, 1)}
              className="rounded border px-2 py-1 disabled:opacity-30">↓</button>
          </>}
        </div>
        <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
      </li>)}
    </ol>
    {!pending && parts.length > 1 && <div className="mt-3 flex gap-2">
      <button disabled={busy} onClick={() => void correct(false)}
        className="rounded border px-3 py-1 disabled:opacity-50">Зберегти порядок</button>
      <button disabled={busy} onClick={() => void correct(true)}
        className="rounded border px-3 py-1 disabled:opacity-50">Розділити SMS</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>;
}
