import { useState, FormEvent } from 'react';
import { api } from '../hooks/useAuth';

export default function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/login', { username, password });
      window.location.href = '/';
    } catch (err) {
      setError('Невірний логін або пароль.');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md">
        <h1 className="mb-6 text-2xl font-bold">Unified Messaging Gateway</h1>
        <p className="mb-4 text-sm text-slate-500">Вхід до панелі керування</p>
        {error && <div className="mb-4 rounded bg-red-100 p-2 text-sm text-red-700">{error}</div>}
        <label className="mb-2 block text-sm font-medium">Користувач</label>
        <input
          className="mb-4 w-full rounded border p-2"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label className="mb-2 block text-sm font-medium">Пароль</label>
        <input
          type="password"
          className="mb-6 w-full rounded border p-2"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button type="submit" className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700">
          Увійти
        </button>
      </form>
    </div>
  );
}
