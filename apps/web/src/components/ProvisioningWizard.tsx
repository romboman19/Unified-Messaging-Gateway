import { useEffect, useState } from 'react';
import { QrImage } from './QrImage';
import { api } from '../hooks/useAuth';
import { Modal } from './ui';
import type {
  Endpoint,
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
  | { kind: 'failed'; message: string };

/**
 * QR provisioning wizard for Signal & WhatsApp channels (TZ §1038).
 *
 * State machine:
 *   idle → entering → qr → linked | failed
 *
 * While the QR is on screen the wizard polls the API every 2 s. The user
 * can close the modal without cancelling — the endpoint row stays in
 * `qr_displayed`, so they can reopen the wizard and resume polling.
 *
 * Per-kind inputs:
 *   - Signal:   label + deviceName (phone comes BACK from sidecar)
 *   - WhatsApp: label + phoneE164 (UnoAPI is per-phone)
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

  const isSignal = account.adapter === 'signal-cli-rest-api';
  const isWhatsapp = account.adapter === 'unoapi';

  // ───── polling once we have a QR ─────
  useEffect(() => {
    if (state.kind !== 'qr') return;
    let active = true;
    const endpointId = state.endpointId;
    const tick = async () => {
      try {
        const res = await api.get<ProvisionPollResult>(
          `/transport-accounts/${account.id}/provision/${endpointId}/poll`,
        );
        if (!active) return;
        if (res.data.state === 'linked') {
          setState({ kind: 'linked', endpoint: res.data.endpoint });
          onLinked();
        } else if (res.data.state === 'failed') {
          setState({
            kind: 'failed',
            message: 'Час очікування QR вичерпано.',
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
  }, [state.kind, state.kind === 'qr' ? state.endpointId : null, account.id, onLinked]);

  async function start() {
    if (!label.trim()) return;
    if (isSignal && !deviceName.trim()) return;
    if (isWhatsapp && !phoneE164.trim()) return;
    setState({ kind: 'entering' });
    try {
      const payload: Record<string, string> = {
        kind: isSignal ? 'signal' : 'whatsapp',
        label: label.trim(),
      };
      if (isSignal) payload['deviceName'] = deviceName.trim();
      if (isWhatsapp) payload['phoneE164'] = phoneE164.trim();
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