import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthUser, LoginResponse } from '@pharmatrack/shared';
import { api, tokenStore } from './api';

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (tokenStore.access) {
        try {
          setUser(await api<AuthUser>('/auth/me'));
        } catch {
          /* token dead; stay logged out */
        }
      }
      setReady(true);
    })();

    const onLogout = () => setUser(null);
    window.addEventListener('pt-logout', onLogout);
    return () => window.removeEventListener('pt-logout', onLogout);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { username, password, deviceLabel: navigator.userAgent.slice(0, 60) },
    });
    tokenStore.set(res);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.refresh;
    tokenStore.clear();
    setUser(null);
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', body: { refreshToken }, retry: false }).catch(() => {});
    }
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}
