import { useEffect, useRef, useState } from 'react';
import { QrImage } from './QrImage';
import { api } from '../hooks/useAuth';
import { Modal } from './ui';
import type {
  Endpoint,
  ProvisionedAccount,
  ProvisionPollResult,
  ProvisionQrResult,
  RegistrationState,
  TransportAccount,
} from '../lib/types';

type WizardState =
  | { kind: 'idle' }
  | { kind: 'entering' }
  | { kind: 'qr'; endpointId: string; uri: string; ttlSeconds: number }
  | { kind: 'linked'; endpoint: Endpoint }
  | { kind: 'failed'; message: string }
  | { kind: 'reconcile'; orphaned: ProvisionedAccount[] };

/**
 * QR provisioning wizard for Signal & WhatsApp channels (TZ §1038).
 *
 * State machine:
 *   idle → entering → qr → linked | failed
 *                    ↘ reconcile (orphan sidecar accounts detected)
 *
 * While the QR is on screen the wizard polls the API every 2 s. The user
 * can close the modal without cancelling — the endpoint row stays in
 * `qr_displayed`, so they can reopen the wizard and resume polling.
 */
export function ProvisioningWizard({
  account,
  onClose,
  onLinked,
}: {
  account: TransportAccount;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [state, setState] = useState<WizardState>({ kind: 'idle' });
  const [label, setLabel] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [phoneE164, setPhoneE164] = useState('');
  const [pollSeq, setPollSeq] = useState(0); // bump to force re-mount of poll effect
  const cancelledRef = useRef(false);

  const isSignal = account.adapter === 'signal-cli-rest-api';
  const isWhatsapp = account.adapter === 'unoapi';

  // ───── reconciliation: list sidecar accounts on open ─────
  useEffect(() => {
    cancelledRef.current = false;
    void (async () => {
      try {
        const res = await api.get<{ accounts: ProvisionedAccount[] }>(
          `/transport-accounts/${account.id}/provision/accounts`,
        );
        const localPhones = new Set(
          account.endpoints
            .map((e) => e.phoneE164)
            .filter((p): p is string => Boolean(p)),
        );
        const orphaned = (res.data.accounts ?? []).filter(
          (a) => a.phoneE164 && !localPhones.has(a.phoneE164),
        );
        if (orphaned.length > 0 && !cancelledRef.current) {
          setState({ kind: 'reconcile', orphaned });
        }
      } catch {
        // Sidecar down on initial load — ignore; user can still try to add.
      }
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [account.id, account.adapter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ───── polling once we have a QR ─────
  useEffect(() => {
    if (state.kind !== 'qr') return;
    let active = true;
    const tick = async () => {
      try {
        const res = await api.get<ProvisionPollResult>(
          `/transport-accounts/${account.id}/provision/${state.endpointId}/poll`,
        );
        if (!active) return;
        if (res.data.state === 'linked') {
          setState({ kind: 'linked', endpoint: res.data.endpoint });
          onLinked();
        } else if (res.data.state === 'failed') {
          setState({
            kind: 'failed',
            message: 'Час очікування QR вичерпано. Запитайте новий.',
          });
        }
      } catch {
        // Transient network blip; keep polling.
      }
    };
    const handle = setInterval(tick, 2000);
    void tick();
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [state.kind === 'qr' ? state.endpointId : null, pollSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (!label.trim()) return;
    setState({ kind: 'entering' });
    try {
      const payload: Record<string, string> = {
        label: label.trim(),
        deviceName: (deviceName || phoneE164).trim(),
      };
      if (phoneE164.trim()) payload['phoneE164'] = phoneE164.trim();
      const res = await api.post<ProvisionQrResult>(
        `/transport-accounts/${account.id}/provision/qrcode`,
        payload,
      );
      setState({
        kind: 'qr',
        endpointId: res.data.endpointId,
        uri: res.data.uri,
        ttlSeconds: res.data.ttlSeconds,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Не вдалося отримати QR-код.';
      setState({ kind: 'failed', message: String(msg) });
    }
  }

  async function cancelProvision() {
    if (state.kind !== 'qr') {
      setState({ kind: 'idle' });
      return;
    }
    try {
      await api.delete(`/endpoints/${state.endpointId}/registration`);
    } catch {
      // Endpoint may already be in a terminal state — ignore.
    }
    setState({ kind: 'idle' });
  }

  async function reattach(orphaned: ProvisionedAccount) {
    if (!orphaned.externalId) return;
    // Pick any existing endpoint in the unpaired state to attach to.
    const target = account.endpoints.find(
      (e) => e.registrationState === 'unpaired' || !e.registrationState,
    );
    if (!target) {
      setState({
        kind: 'failed',
        message: 'Створіть новий endpoint для привʼязки знайденого акаунта.',
      });
      return;
    }
    try {
      await api.post(
        `/transport-accounts/${account.id}/provision/${target.id}/reattach`,
        { externalId: orphaned.externalId },
      );
      onLinked();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Не вдалося привʼязати акаунт.';
      setState({ kind: 'failed', message: String(msg) });
    }
  }

  return (
    <Modal title={`Прив'язати номер: ${account.name}`} onClose={onClose} wide>
      {state.kind === 'idle' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Введіть назву і {isSignal ? 'імʼя пристрою Signal' : 'номер телефону WhatsApp'}.
            Після запуску система згенерує QR-код — відскануйте його у відповідному додатку.
          </p>
          <div>
            <label className="mb-1 block text-sm">Назва (мітка)</label>
            <input
              className="w-full rounded border p-2"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Наприклад: Основний Signal"
              required
            />
          </div>
          {isSignal && (
            <div>
              <label className="mb-1 block text-sm">Імʼя пристрою Signal</label>
              <input
                className="w-full rounded border p-2"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="umg-1"
                required
              />
            </div>
          )}
          {isWhatsapp && (
            <div>
              <label className="mb-1 block text-sm">Номер телефону (E.164)</label>
              <input
                className="w-full rounded border p-2"
                value={phoneE164}
                onChange={(e) => setPhoneE164(e.target.value)}
                placeholder="+380XXXXXXXXX"
                required
              />
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-slate-100">
              Скасувати
            </button>
            <button
              onClick={start}
              disabled={!label.trim() || (isSignal ? !deviceName.trim() : !phoneE164.trim())}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Почати
            </button>
          </div>
        </div>
      )}

      {state.kind === 'entering' && (
        <div className="py-8 text-center text-slate-500">Запитуємо QR у транспорту…</div>
      )}

      {state.kind === 'qr' && (
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-slate-600">
            Відскануйте QR у додатку {isSignal ? 'Signal' : 'WhatsApp'}. Після сканування endpoint автоматично стане активним.
          </p>
          <QrImage uri={state.uri} />
          {state.ttlSeconds > 0 && (
            <p className="text-xs text-slate-400">
              QR дійсний {Math.round(state.ttlSeconds / 60)} хв. Після прострочення — система автоматично переведе endpoint у помилку.
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => {
                setState({ kind: 'idle' });
                setPollSeq((s) => s + 1);
              }}
              className="rounded border px-4 py-2 text-sm hover:bg-slate-100"
            >
              Перегенерувати
            </button>
            <button
              onClick={cancelProvision}
              className="rounded border px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              Скасувати
            </button>
          </div>
        </div>
      )}

      {state.kind === 'linked' && (
        <div className="space-y-4 text-center">
          <p className="text-lg font-medium text-green-700">Готово!</p>
          <p className="text-sm text-slate-600">
            Endpoint <strong>{state.endpoint.label}</strong> привʼязано
            {state.endpoint.phoneE164 ? ` до ${state.endpoint.phoneE164}` : ''}.
          </p>
          <button
            onClick={onClose}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Закрити
          </button>
        </div>
      )}

      {state.kind === 'failed' && (
        <div className="space-y-4">
          <div className="rounded bg-red-100 p-3 text-sm text-red-700">{state.message}</div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setState({ kind: 'idle' })}
              className="rounded border px-4 py-2 text-sm hover:bg-slate-100"
            >
              Спробувати ще
            </button>
            <button onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-slate-100">
              Закрити
            </button>
          </div>
        </div>
      )}

      {state.kind === 'reconcile' && (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Знайдено {state.orphaned.length} акаунт(ів) на транспорті, які не привʼязані до жодного endpoint:
          </p>
          <ul className="space-y-2">
            {state.orphaned.map((o) => (
              <li key={o.externalId} className="flex items-center justify-between rounded border p-2">
                <span className="text-sm">
                  {o.phoneE164 ?? o.externalId}
                  {o.deviceName && <span className="ml-2 text-slate-400">({o.deviceName})</span>}
                </span>
                <button
                  onClick={() => reattach(o)}
                  className="rounded border px-3 py-1 text-sm hover:bg-slate-100"
                >
                  Привʼязати
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button
              onClick={() => setState({ kind: 'idle' })}
              className="rounded border px-4 py-2 text-sm hover:bg-slate-100"
            >
              Додати новий
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Tiny helper used by Channels.tsx to keep endpoint-table state legible.
 */
export function registrationBadge(state: RegistrationState | undefined): {
  label: string;
  color: string;
} {
  switch (state) {
    case 'linked':
      return { label: 'привʼязаний', color: 'bg-green-100 text-green-700' };
    case 'qr_pending':
    case 'qr_displayed':
      return { label: 'очікує QR', color: 'bg-amber-100 text-amber-700' };
    case 'sms_pending':
    case 'verifying':
      return { label: 'перевірка коду', color: 'bg-amber-100 text-amber-700' };
    case 'relink_needed':
      return { label: 'потрібна повторна привʼязка', color: 'bg-amber-100 text-amber-700' };
    case 'failed':
      return { label: 'помилка привʼязки', color: 'bg-red-100 text-red-700' };
    case 'unpaired':
    default:
      return { label: 'не привʼязаний', color: 'bg-slate-100 text-slate-500' };
  }
}