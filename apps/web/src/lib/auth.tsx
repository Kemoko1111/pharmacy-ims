import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthUser, LoginResponse } from '@pharmatrack/shared';
import { ApiError, api, tokenStore } from './api';

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  waking: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

// Cold-start handling for the free-tier API (Risk R6): if /auth/me is slow to
// answer, adopt the cached shift session after a short grace period so the app
// is usable immediately, and hard-cap the request so it can never hang forever.
const COLD_START_GRACE_MS = 2500;
const AUTH_ME_TIMEOUT_MS = 20_000;

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
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!tokenStore.access) {
        setReady(true);
        return;
      }

      const cached = restoreSession();
      // If the server is slow (cold start), don't hang on "Loading…": after a
      // short grace period adopt the cached shift session so the app is usable,
      // or — with nothing to fall back on — show a "waking up" notice.
      const graceTimer = setTimeout(() => {
        if (cancelled) return;
        if (cached) {
          setUser(cached);
          setReady(true);
        } else {
          setWaking(true);
        }
      }, COLD_START_GRACE_MS);

      // Hard cap so the request can never hang the app indefinitely.
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), AUTH_ME_TIMEOUT_MS);

      try {
        const me = await api<AuthUser>('/auth/me', { signal: controller.signal });
        if (cancelled) return;
        cacheSession(me);
        setUser(me);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          // server said no — session is genuinely dead; override any cached fallback
          localStorage.removeItem(SESSION_KEY);
          setUser(null);
        } else if (!cached) {
          // network/cold failure and nothing cached — stay logged out
          setUser(null);
        }
        // network failure WITH a cached session: the grace timer already adopted it
      } finally {
        clearTimeout(graceTimer);
        clearTimeout(abortTimer);
        if (!cancelled) {
          setWaking(false);
          setReady(true);
        }
      }
    })();

    const onLogout = () => {
      localStorage.removeItem(SESSION_KEY);
      setUser(null);
    };
    window.addEventListener('pt-logout', onLogout);
    return () => {
      cancelled = true;
      window.removeEventListener('pt-logout', onLogout);
    };
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

  return <Ctx.Provider value={{ user, ready, waking, login, logout }}>{children}</Ctx.Provider>;
}
