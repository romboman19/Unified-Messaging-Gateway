import { useState } from 'react';
import { api } from '../hooks/useAuth';
import { Endpoint } from '../lib/types';
import { apiError } from '../lib/format';

export function SmsGroupingSettings({ endpoint, onSaved }: { endpoint: Endpoint; onSaved: () => void }) {
  const current = endpoint.configJson?.smsGrouping;
  const [enabled, setEnabled] = useState(current?.enabled ?? false);
  const [idle, setIdle] = useState(current?.idleSeconds ?? 25);
  const [maximum, setMaximum] = useState(current?.maxSeconds ?? 90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  return <form className="mt-3 space-y-2 border-t pt-3 text-sm" onChange={() => setSaved(false)}
    onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true); setError(''); setSaved(false);
      try {
        await api.patch(`/endpoints/${endpoint.id}`, {
          config: { smsGrouping: { enabled, idleSeconds: idle, maxSeconds: maximum } },
        });
        setSaved(true); onSaved();
      } catch (err) { setError(apiError(err, 'Не вдалося зберегти групування.')); }
      finally { setBusy(false); }
    }}>
    <label className="flex items-center gap-2 font-medium">
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      Групувати вхідні SMS приблизно
    </label>
    <p className="text-xs text-slate-500">
      Частини одного відправника збираються за часом надходження.
      Окремі SMS поспіль можуть потрапити в одну групу. Усі вхідні SMS цієї SIM
      пересилаються після очікування. Оригінали зберігаються.
    </p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs">Пауза після частини, с
        <input className="ml-2 w-20 rounded border p-1" type="number" min={5} max={120}
          required value={idle} onChange={(e) => setIdle(Number(e.target.value))} />
      </label>
      <label className="text-xs">Максимум від першої, с
        <input className="ml-2 w-20 rounded border p-1" type="number" min={idle} max={300}
          required value={maximum} onChange={(e) => setMaximum(Number(e.target.value))} />
      </label>
      <button disabled={busy} className="rounded border px-2 py-1 disabled:opacity-50">
        {busy ? 'Збереження…' : 'Зберегти групування'}
      </button>
      {saved && <span role="status" className="text-xs text-green-700">Збережено</span>}
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </form>;
}
