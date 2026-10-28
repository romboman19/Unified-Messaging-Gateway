import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Radio,
  MessageSquare,
  Mail,
  Route,
  Webhook,
  Bell,
  KeyRound,
  ScrollText,
  LogOut,
} from 'lucide-react';
import { api } from '../hooks/useAuth';

const nav = [
  { label: 'Огляд', icon: LayoutDashboard, href: '/' },
  { label: 'Канали', icon: Radio, href: '/channels' },
  { label: 'Тест-чат', icon: MessageSquare, href: '/chat' },
  { label: 'Повідомлення', icon: Mail, href: '/messages' },
  { label: 'Маршрутизація', icon: Route, href: '/routing' },
  { label: 'Доставки вебхуків', icon: Webhook, href: '/deliveries' },
  { label: 'Сповіщення', icon: Bell, href: '/alerts' },
  { label: 'API', icon: KeyRound, href: '/api' },
  { label: 'Логи', icon: ScrollText, href: '/logs' },
];

export default function Layout() {
  async function logout() {
    await api.post('/auth/logout');
    window.location.href = '/login';
  }

  // The API's own version, so a half-finished deploy (new panel, old API or
  // the reverse) is visible instead of showing up as odd behaviour.
  const apiVersion = useQuery({
    queryKey: ['api-version'],
    queryFn: async () => (await api.get<{ version: string }>('/health/version')).data.version,
    staleTime: 5 * 60_000,
  });
  const mismatch = apiVersion.data && apiVersion.data !== __APP_VERSION__;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 flex-col border-r bg-white p-4">
        <div className="mb-6">
          <div className="text-xl font-bold">UMG</div>
          <div className="text-xs text-slate-400" title="Версія веб-панелі">
            v{__APP_VERSION__}
          </div>
          {mismatch && (
            <div
              className="mt-1 text-xs text-amber-600"
              title="Веб-панель і API різних версій — оновіть обидва контейнери"
            >
              API v{apiVersion.data}
            </div>
          )}
        </div>
        <nav className="space-y-1">
          {nav.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded px-3 py-2 text-sm ${
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              <item.icon size={18} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={logout}
          className="mt-auto flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-red-600 hover:bg-red-50"
        >
          <LogOut size={18} />
          Вийти
        </button>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
