import { FormEvent, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { OfflineLoginError, useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { hasOfflineCredential } from '../lib/offlineCreds';
import { useOnline } from '../lib/useOnline';

export default function Login() {
  const { user, login } = useAuth();
  const { online, unsynced } = useOnline();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canSignInOffline, setCanSignInOffline] = useState(false);

  useEffect(() => {
    hasOfflineCredential().then(setCanSignInOffline).catch(() => {});
  }, []);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      if (err instanceof ApiError || err instanceof OfflineLoginError) setError(err.message);
      else setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center bg-bg p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-edge bg-surface p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-primary">PharmaTrack</h1>
        <p className="mb-6 mt-1 text-sm text-ink-muted">Sign in to start your shift</p>

        {/* An outage at opening time is the moment a cashier most needs to know
            whether signing in will work at all. */}
        {!online && (
          <div className="mb-5 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
            <span className="font-semibold">● OFFLINE</span> —{' '}
            {canSignInOffline
              ? 'you can sign in with the password saved on this till. Sales will queue until the server is back.'
              : 'this till has no saved sign-in yet, so the server is needed. Restore the connection and try again.'}
            {unsynced > 0 && (
              <div className="mt-1 font-semibold">
                {unsynced} sale{unsynced > 1 ? 's' : ''} still waiting to sync from this till.
              </div>
            )}
          </div>
        )}

        {online && unsynced > 0 && (
          <div className="mb-5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
            {unsynced} sale{unsynced > 1 ? 's' : ''} from an earlier shift {unsynced > 1 ? 'are' : 'is'}{' '}
            waiting — sign in to send {unsynced > 1 ? 'them' : 'it'} up.
          </div>
        )}

        <label className="mb-1 block text-sm font-medium" htmlFor="login-username">Username</label>
        <input
          id="login-username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 w-full rounded-lg border border-edge bg-bg px-3 py-2.5 outline-none focus:border-primary"
          autoComplete="username"
        />

        <label className="mb-1 block text-sm font-medium" htmlFor="login-password">Password</label>
        <div className="relative mb-4">
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-edge bg-bg px-3 py-2.5 pr-10 outline-none focus:border-primary"
            autoComplete="current-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-muted hover:text-ink"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>

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

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 1 12s4 7 11 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="M2 2l20 20" />
    </svg>
  );
}
