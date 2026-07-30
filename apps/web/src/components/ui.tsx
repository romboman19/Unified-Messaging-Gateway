import { ReactNode } from 'react';
import { X } from 'lucide-react';
import { AlertSeverity, ChannelType, DeliveryStatus, MessageDirection, MessageStatus } from '../lib/types';

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-lg bg-white p-6 shadow-xl ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-100" title="Закрити">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  text,
  onConfirm,
  onCancel,
  busy,
}: {
  text: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title="Підтвердження" onClose={onCancel}>
      <p className="text-sm text-slate-600">{text}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded border px-4 py-2 text-sm hover:bg-slate-100">
          Скасувати
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
        >
          Підтвердити
        </button>
      </div>
    </Modal>
  );
}

export function Badge({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {children}
    </span>
  );
}

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  created: 'створено',
  scheduled: 'заплановано',
  queued: 'в черзі',
  dispatching: 'відправляється',
  accepted: 'прийнято',
  sent: 'надіслано',
  delivered: 'доставлено',
  read: 'прочитано',
  failed: 'помилка',
  cancelled: 'скасовано',
  expired: 'прострочено',
  unknown: 'невідомо',
};

export const MESSAGE_STATUS_COLOR: Record<MessageStatus, string> = {
  created: 'bg-slate-100 text-slate-600',
  scheduled: 'bg-indigo-100 text-indigo-700',
  queued: 'bg-amber-100 text-amber-700',
  dispatching: 'bg-amber-100 text-amber-700',
  accepted: 'bg-blue-100 text-blue-700',
  sent: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
  read: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-100 text-slate-500',
  expired: 'bg-slate-100 text-slate-500',
  unknown: 'bg-slate-100 text-slate-500',
};

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  mock: 'Тестовий (mock)',
};

export const DIRECTION_LABEL: Record<MessageDirection, string> = {
  inbound: 'вхідне',
  outbound: 'вихідне',
};

export const DIRECTION_COLOR: Record<MessageDirection, string> = {
  inbound: 'bg-slate-100 text-slate-600',
  outbound: 'bg-blue-100 text-blue-700',
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: 'очікує',
  delivering: 'доставляється',
  delivered: 'доставлено',
  failed: 'помилка',
  dlq: 'DLQ',
};

export const DELIVERY_STATUS_COLOR: Record<DeliveryStatus, string> = {
  pending: 'bg-amber-100 text-amber-700',
  delivering: 'bg-blue-100 text-blue-700',
  delivered: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  dlq: 'bg-purple-100 text-purple-700',
};

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'інфо',
  warning: 'попередження',
  critical: 'критично',
};

export const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  info: 'bg-blue-100 text-blue-700',
  warning: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
};
