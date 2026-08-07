/**
 * Fetch wrapper: bearer token, one silent refresh-and-retry on 401 (rotating
 * refresh tokens, ADR-005), and typed error envelopes (api-schema.md).
 *
 * Every request is time-boxed. A till on a weak pharmacy link does not get a
 * TCP reset — the socket simply hangs, and `fetch` waits on it for minutes. At
 * a POS that is worse than an outright failure: the cashier presses Enter to
 * take the money and the dialog sits on "Completing…" with a customer waiting.
 * A timeout turns that hang into a network failure, which the offline queue
 * already knows how to handle (ADR-006).
 */

import {
  getCachedResponse,
  noteFreshRead,
  noteNoOfflineCopy,
  noteStaleRead,
  putCachedResponse,
} from './offlineCache';

export const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/** Origin root — `/health` is deliberately unprefixed (api-schema.md). */
export const API_ROOT = BASE.replace(/\/api\/v1\/?$/, '');

/** Long enough for a Render cold start to answer, short enough to not strand a sale. */
export const REQUEST_TIMEOUT_MS = 15_000;

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

/**
 * The server was never reached — DNS, socket, CORS or our own timeout. Callers
 * treat this as "go offline", never as "the server said no", so it must stay
 * distinguishable from ApiError at every call site.
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly timedOut = false,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Offline, and this screen has no cached copy because it was never opened while
 * online (ADR-013). A NetworkError subclass so every existing "we are offline"
 * branch keeps working; screens that want to say something more useful than
 * "connection failed" can single it out.
 */
export class OfflineDataUnavailableError extends NetworkError {
  constructor(public readonly path: string) {
    super('No offline copy of this screen — open it once while online');
    this.name = 'OfflineDataUnavailableError';
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
  /**
   * Replaces only the access token. Switching branch (ADR-010) re-issues the
   * access token against the new branch while the refresh token — which is tied
   * to the device session, not the branch — stays put.
   */
  setAccess(accessToken: string) {
    localStorage.setItem('pt-access', accessToken);
  },
  clear() {
    localStorage.removeItem('pt-access');
    localStorage.removeItem('pt-refresh');
  },
};

export const tokenStore = store;

/**
 * `fetch` with a deadline, reported as NetworkError rather than a bare
 * AbortError so callers can tell our timeout from a caller cancellation.
 * `AbortSignal.any` is not assumed — tills run whatever browser the shop has.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const caller = init.signal;
  const forward = () => controller.abort();
  caller?.addEventListener('abort', forward);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new NetworkError(`Request timed out after ${timeoutMs} ms`, true);
    if (caller?.aborted) throw err; // caller cancelled on purpose — let it through
    throw new NetworkError(err instanceof Error ? err.message : 'Network request failed');
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', forward);
  }
}

/**
 * Every attempt to reach the API reports its outcome here. The connectivity
 * layer listens, so a real request failing flips the badge to OFFLINE straight
 * away instead of waiting for the next heartbeat.
 */
function reportReachability(reached: boolean) {
  window.dispatchEvent(new CustomEvent('pt-reachability', { detail: { reached } }));
}

type RefreshOutcome = 'ok' | 'rejected' | 'network';
let refreshing: Promise<RefreshOutcome> | null = null;

async function tryRefresh(): Promise<RefreshOutcome> {
  if (!store.refresh) return 'rejected';
  refreshing ??= (async () => {
    try {
      const res = await fetchWithTimeout(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: store.refresh }),
      });
      if (!res.ok) return 'rejected' as const; // server said no — session dead
      store.set(await res.json());
      return 'ok' as const;
    } catch {
      return 'network' as const; // outage — keep the shift session (ADR-006)
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    retry?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    /**
     * Serve this GET from the offline cache when the server cannot be reached,
     * and record successful answers for that purpose (ADR-013). Off for callers
     * that already have a purpose-built offline path — the POS reads its
     * catalogue snapshot, which knows this branch's stock, rather than whatever
     * a previous search happened to return.
     */
    cache?: boolean;
  } = {},
): Promise<T> {
  const { method = 'GET', body, retry = true, signal, timeoutMs, cache = true } = options;
  const cacheable = cache && method === 'GET';

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${BASE}${path}`,
      {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(store.access ? { Authorization: `Bearer ${store.access}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      },
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof NetworkError) reportReachability(false);
    // The request never reached the server. For a read, the last answer we were
    // given is far more use than an empty screen — as long as the UI is honest
    // about how old it is.
    if (err instanceof NetworkError && cacheable) {
      const hit = await getCachedResponse(path);
      if (hit) {
        noteStaleRead(hit.fetchedAt);
        return hit.data as T;
      }
      noteNoOfflineCopy(path);
      throw new OfflineDataUnavailableError(path);
    }
    throw err;
  }
  reportReachability(true);

  if (res.status === 401 && retry && store.refresh) {
    const outcome = await tryRefresh();
    if (outcome === 'ok') return api(path, { method, body, retry: false });
    if (outcome === 'rejected') {
      store.clear();
      window.dispatchEvent(new Event('pt-logout'));
    }
    // 'network': fall through with the original 401 — don't end the shift
  }

  if (res.status === 204) return undefined as T;

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details, json);
  }
  if (cacheable) {
    noteFreshRead();
    void putCachedResponse(path, json); // best-effort; a full disk must not fail a read
  }
  return json as T;
}
