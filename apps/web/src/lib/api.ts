/**
 * Fetch wrapper: bearer token, one silent refresh-and-retry on 401 (rotating
 * refresh tokens, ADR-005), and typed error envelopes (api-schema.md).
 */

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
    public body?: unknown,
  ) {
    super(message);
  }
}

const store = {
  get access() {
    return localStorage.getItem('pt-access');
  },
  get refresh() {
    return localStorage.getItem('pt-refresh');
  },
  set(tokens: { accessToken: string; refreshToken: string }) {
    localStorage.setItem('pt-access', tokens.accessToken);
    localStorage.setItem('pt-refresh', tokens.refreshToken);
  },
  clear() {
    localStorage.removeItem('pt-access');
    localStorage.removeItem('pt-refresh');
  },
};

export const tokenStore = store;

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!store.refresh) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: store.refresh }),
      });
      if (!res.ok) return false;
      store.set(await res.json());
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; retry?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, retry = true } = options;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(store.access ? { Authorization: `Bearer ${store.access}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && store.refresh) {
    if (await tryRefresh()) return api(path, { method, body, retry: false });
    store.clear();
    window.dispatchEvent(new Event('pt-logout'));
  }

  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details, json);
  }
  return json as T;
}
