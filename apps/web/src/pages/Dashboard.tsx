import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, Send, Webhook } from 'lucide-react';
import { api } from '../hooks/useAuth';
import { Alert, Delivery, ListResponse, Message } from '../lib/types';

export default function DashboardPage() {
  const outbound = useQuery({
    queryKey: ['dashboard', 'messages-outbound'],
    queryFn: async () => (await api.get<ListResponse<Message>>('/messages', { params: { direction: 'outbound', limit: 100 } })).data,
  });
  const failed = useQuery({
    queryKey: ['dashboard', 'messages-failed'],
    queryFn: async () => (await api.get<ListResponse<Message>>('/messages', { params: { status: 'failed', limit: 100 } })).data,
  });
  const dlq = useQuery({
    queryKey: ['dashboard', 'deliveries-dlq'],
    queryFn: async () => (await api.get<ListResponse<Delivery>>('/deliveries', { params: { status: 'dlq', limit: 1 } })).data,
  });
  const firing = useQuery({
    queryKey: ['dashboard', 'alerts-firing'],
    queryFn: async () => (await api.get<ListResponse<Alert>>('/alerts', { params: { status: 'firing', limit: 1 } })).data,
  });

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const sent24h =
    outbound.data?.items.filter((m) => new Date(m.createdAt).getTime() >= dayAgo).length ?? 0;
  const failedCount = failed.data?.count ?? 0;
  const dlqCount = dlq.data?.count ?? 0;
  const firingCount = firing.data?.count ?? 0;

  const widgets = [
    {
      label: 'Надіслано за 24 год',
      value: sent24h,
      icon: Send,
      color: 'text-blue-600',
      loading: outbound.isLoading,
    },
    {
      label: 'Помилкові повідомлення',
      value: failedCount,
      icon: Ban,
      color: failedCount > 0 ? 'text-red-600' : 'text-slate-600',
      loading: failed.isLoading,
    },
    {
      label: 'Доставки в DLQ',
      value: dlqCount,
      icon: Webhook,
      color: dlqCount > 0 ? 'text-purple-600' : 'text-slate-600',
      loading: dlq.isLoading,
    },
    {
      label: 'Активні сповіщення',
      value: firingCount,
      icon: AlertTriangle,
      color: firingCount > 0 ? 'text-amber-600' : 'text-slate-600',
      loading: firing.isLoading,
    },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold">Огляд</h2>
      <p className="mt-2 text-slate-500">Панель керування UMG.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-4">
        {widgets.map((w) => (
          <div key={w.label} className="rounded-lg bg-white p-4 shadow">
            <div className="flex items-center justify-between">
              <div className="text-sm text-slate-500">{w.label}</div>
              <w.icon size={18} className={w.color} />
            </div>
            <div className={`mt-1 text-2xl font-semibold ${w.color}`}>
              {w.loading ? '…' : w.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg bg-white p-4 shadow">
          <div className="text-sm text-slate-500">Core сервіси</div>
          <div className="mt-1 text-lg font-semibold text-green-600">активні</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <div className="text-sm text-slate-500">API</div>
          <div className="mt-1 text-lg font-semibold">/api/v1</div>
        </div>
        <div className="rounded-lg bg-white p-4 shadow">
          <div className="text-sm text-slate-500">Версія</div>
          <div className="mt-1 text-lg font-semibold">0.1.0</div>
        </div>
      </div>
    </div>
  );
}
