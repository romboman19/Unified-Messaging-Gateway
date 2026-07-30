import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Radio, Settings, LogOut, LayoutDashboard, Bell, CreditCard } from 'lucide-react';
import { api } from '../hooks/useAuth';

const nav = [
  { label: 'Огляд', icon: LayoutDashboard, href: '/' },
  { label: 'Канали', icon: Radio, href: '/channels' },
  { label: 'Діалоги', icon: MessageSquare, href: '/conversations' },
  { label: 'Алерти', icon: Bell, href: '/alerts' },
  { label: 'SIM та баланс', icon: CreditCard, href: '/sims' },
  { label: 'Налаштування', icon: Settings, href: '/settings' },
];

export default function DashboardPage() {
  const location = useLocation();

  async function logout() {
    await api.post('/auth/logout');
    window.location.href = '/login';
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-white p-4">
        <div className="mb-6 text-xl font-bold">UMG</div>
        <nav className="space-y-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              to={item.href}
              className={`flex items-center gap-2 rounded px-3 py-2 text-sm ${
                location.pathname === item.href ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <item.icon size={18} />
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          onClick={logout}
          className="mt-8 flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-red-600 hover:bg-red-50"
        >
          <LogOut size={18} />
          Вийти
        </button>
      </aside>
      <main className="flex-1 p-8">
        <h2 className="text-2xl font-bold">Огляд</h2>
        <p className="mt-2 text-slate-500">Панель керування UMG. Розділи знаходяться в розробці.</p>
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
      </main>
    </div>
  );
}
