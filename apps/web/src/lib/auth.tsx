import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AuthUser, LoginResponse, SwitchBranchResponse } from '@pharmatrack/shared';
import { ApiError, api, tokenStore } from './api';
import { setActiveBranch } from './offline';
import { rememberCredential, verifyOffline } from './offlineCreds';

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  waking: boolean;
  /**
   * True when this session was opened against the cached verifier rather than
   * the server. Nothing it does reaches the database until the till is back
   * online and a real session posts the queue, so the UI says so out loud.
   */
  offlineSession: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-issues the token against another branch (ADR-010). */
  switchBranch: (branchId: string | null) => Promise<void>;
}

/** Thrown by `login` when neither the server nor the cached verifier let us in. */
export class OfflineLoginError extends Error {}

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

function cacheSession(user: AuthUser, offline = false) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ user, verifiedAt: Date.now(), offline }));
}

/**
 * Keeps the offline layer pointed at the same branch as the session. The
 * cached catalogue carries per-branch stock, so this must happen on every path
 * that establishes or changes a session — login, restore, /auth/me, switch.
 */
function adoptSession(user: AuthUser | null) {
  setActiveBranch(user?.activeBranch?.id ?? null);
}

function restoreSession(): { user: AuthUser; offline: boolean } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { user, verifiedAt, offline } = JSON.parse(raw);
    if (Date.now() - verifiedAt > SESSION_TTL_MS) return null;
    return { user: user as AuthUser, offline: !!offline };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [waking, setWaking] = useState(false);
  const [offlineSession, setOfflineSession] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const cached = restoreSession();

      if (!tokenStore.access) {
        // An offline sign-in issues no tokens, so this is the normal path for
        // a till that reloads (or a PWA that restarts) during an outage.
        // Without it, the cashier is thrown back to a login screen that cannot
        // reach anything — the exact deadlock offline sign-in exists to avoid.
        if (cached?.offline) {
          adoptSession(cached.user);
          setOfflineSession(true);
          setUser(cached.user);
        }
        setReady(true);
        return;
      }

      // If the server is slow (cold start), don't hang on "Loading…": after a
      // short grace period adopt the cached shift session so the app is usable,
      // or — with nothing to fall back on — show a "waking up" notice.
      const graceTimer = setTimeout(() => {
        if (cancelled) return;
        if (cached) {
          adoptSession(cached.user);
          setUser(cached.user);
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
        adoptSession(me);
        setOfflineSession(false);
        setUser(me);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          // server said no — session is genuinely dead; override any cached fallback
          localStorage.removeItem(SESSION_KEY);
          adoptSession(null);
          setUser(null);
        } else if (!cached) {
          // network/cold failure and nothing cached — stay logged out
          adoptSession(null);
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
      adoptSession(null);
      setOfflineSession(false);
      setUser(null);
    };
    window.addEventListener('pt-logout', onLogout);
    return () => {
      cancelled = true;
      window.removeEventListener('pt-logout', onLogout);
    };
  }, []);

  /**
   * Online first, always. The cached verifier is consulted only when the server
   * could not be reached at all — an ApiError means the server answered and
   * said no, and no local cache may override that.
   */
  const login = useCallback(async (username: string, password: string) => {
    try {
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username, password, deviceLabel: navigator.userAgent.slice(0, 60) },
      });
      tokenStore.set(res);
      cacheSession(res.user);
      adoptSession(res.user);
      setOfflineSession(false);
      setUser(res.user);
      // Renew the offline verifier on every real sign-in, so what the till will
      // accept during the next outage is what the server accepted just now.
      await rememberCredential(username, password, res.user).catch(() => {});
    } catch (err) {
      if (err instanceof ApiError) throw err; // the server rejected them

      const offline = await verifyOffline(username, password);
      if (!offline.ok) {
        throw new OfflineLoginError(
          offline.reason === 'mismatch'
            ? 'Wrong username or password' // don't leak that we are offline-verifying
            : `Cannot reach the server. ${offline.message}.`,
        );
      }
      // No tokens: there is nothing to sign one with. The till works from the
      // local catalogue and queues its sales; the first successful request once
      // the link returns will 401 and send the cashier back here to sign in for
      // real, with the queue intact.
      cacheSession(offline.user);
      adoptSession(offline.user);
      setOfflineSession(true);
      setUser(offline.user);
    }
  }, []);

  /**
   * Branch lives in the signed token, so switching is a round-trip rather than
   * a client-side flag (ADR-010). The offline catalogue is re-pointed first so
   * no POS read can serve the previous branch's stock in between.
   */
  const switchBranch = useCallback(async (branchId: string | null) => {
    const res = await api<SwitchBranchResponse>('/auth/switch-branch', {
      method: 'POST',
      body: { branchId },
    });
    tokenStore.setAccess(res.accessToken);
    setActiveBranch(res.activeBranch?.id ?? null);
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, activeBranch: res.activeBranch, branches: res.branches };
      cacheSession(next); // reaching the server proves this is a real session
      return next;
    });
    setOfflineSession(false);
  }, []);

  /**
   * Ends the session but deliberately keeps the offline verifier: a cashier
   * signing out at close of business must still be able to open the till
   * tomorrow morning if the line is down. Revoking a device is a separate,
   * explicit act (`forgetOfflineCredentials`, offered in Settings).
   */
  const logout = useCallback(async () => {
    const refreshToken = tokenStore.refresh;
    tokenStore.clear();
    localStorage.removeItem(SESSION_KEY);
    adoptSession(null);
    setOfflineSession(false);
    setUser(null);
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', body: { refreshToken }, retry: false }).catch(() => {});
    }
  }, []);

  return (
    <Ctx.Provider value={{ user, ready, waking, offlineSession, login, logout, switchBranch }}>
      {children}
    </Ctx.Provider>
  );
}
