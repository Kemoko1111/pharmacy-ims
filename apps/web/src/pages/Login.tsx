import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

export default function Login() {
  const { user, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-bg p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-edge bg-surface p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-primary">PharmaTrack</h1>
        <p className="mb-6 mt-1 text-sm text-ink-muted">Sign in to start your shift</p>

        <label className="mb-1 block text-sm font-medium">Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 w-full rounded-lg border border-edge bg-bg px-3 py-2.5 outline-none focus:border-primary"
          autoComplete="username"
        />

        <label className="mb-1 block text-sm font-medium">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-edge bg-bg px-3 py-2.5 outline-none focus:border-primary"
          autoComplete="current-password"
        />

        {error && <p className="mb-4 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <button
          disabled={busy || !username || !password}
          className="w-full rounded-lg bg-primary py-2.5 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
