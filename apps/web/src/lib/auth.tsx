import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthUser, LoginResponse } from '@pharmatrack/shared';
import { ApiError, api, tokenStore } from './api';

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

// ADR-006: a till reload during an outage must not stop selling. The last
// verified session is cached for the shift length (12 h); a real 401 still
// logs out — only NETWORK failure falls back to the cache.
const SESSION_KEY = 'pt-session';
const SESSION_TTL_MS = 12 * 3600_000;

function cacheSession(user: AuthUser) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ user, verifiedAt: Date.now() }));
}

function restoreSession(): AuthUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { user, verifiedAt } = JSON.parse(raw);
    if (Date.now() - verifiedAt > SESSION_TTL_MS) return null;
    return user as AuthUser;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (tokenStore.access) {
        try {
          const me = await api<AuthUser>('/auth/me');
          cacheSession(me);
          setUser(me);
        } catch (err) {
          if (err instanceof ApiError) {
            // server said no — session is genuinely dead
            localStorage.removeItem(SESSION_KEY);
          } else {
            // network down: restore the cached shift session (≤12 h old)
            const cached = restoreSession();
            if (cached) setUser(cached);
          }
        }
      }
      setReady(true);
    })();

    const onLogout = () => {
      localStorage.removeItem(SESSION_KEY);
      setUser(null);
    };
    window.addEventListener('pt-logout', onLogout);
    return () => window.removeEventListener('pt-logout', onLogout);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { username, password, deviceLabel: navigator.userAgent.slice(0, 60) },
    });
    tokenStore.set(res);
    cacheSession(res.user);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.refresh;
    tokenStore.clear();
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', body: { refreshToken }, retry: false }).catch(() => {});
    }
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}
