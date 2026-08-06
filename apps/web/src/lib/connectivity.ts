/**
 * Reachability, not link state.
 *
 * `navigator.onLine` only says the machine has a network interface with a
 * route. In the shop that is routinely a lie: the router is up but the DSL is
 * down, the phone hotspot has no credit, or the free-tier API is asleep. The
 * till then shows "● ONLINE", every POS action tries a live request, and the
 * offline queue — the whole point of ADR-006 — never engages.
 *
 * So online means "the API answered recently". `navigator.onLine === false` is
 * still trusted as an immediate offline signal (it is never wrong in that
 * direction); everything else is decided by a heartbeat against GET /health
 * plus the outcome of the real requests the app is already making.
 */
import { API_ROOT, fetchWithTimeout, tokenStore } from './api';

export type Reachability = 'online' | 'offline';

/** Health must answer fast; a cold-starting API is not a usable API for a till. */
const PROBE_TIMEOUT_MS = 8_000;
/** While down, look for recovery often — queued sales are waiting on it. */
const PROBE_INTERVAL_DOWN_MS = 20_000;
/** While up, just enough to notice a silent drop between real requests. */
const PROBE_INTERVAL_UP_MS = 60_000;

type Listener = (status: Reachability) => void;

let status: Reachability = navigator.onLine ? 'online' : 'offline';
let probing: Promise<Reachability> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
const listeners = new Set<Listener>();

function setStatus(next: Reachability) {
  if (next === status) return;
  status = next;
  for (const l of listeners) l(status);
  window.dispatchEvent(new CustomEvent('pt-reachability-changed', { detail: { status } }));
  rearm();
}

/** Poll faster while down than while up, without stacking timers. */
function rearm() {
  if (timer) clearInterval(timer);
  const every = status === 'online' ? PROBE_INTERVAL_UP_MS : PROBE_INTERVAL_DOWN_MS;
  timer = setInterval(() => void probe(), every);
}

/**
 * Ask the API whether it is there. Concurrent callers share one in-flight
 * probe so a burst of triggers (focus + online event + a failed request) does
 * not turn into a burst of requests.
 */
export function probe(): Promise<Reachability> {
  if (!navigator.onLine) {
    setStatus('offline');
    return Promise.resolve('offline');
  }
  probing ??= (async () => {
    try {
      const res = await fetchWithTimeout(
        `${API_ROOT}/health`,
        { method: 'GET', cache: 'no-store' },
        PROBE_TIMEOUT_MS,
      );
      // Any HTTP answer proves the server is reachable. A degraded database is
      // the API's problem to report, not a reason to switch the till offline —
      // requests will fail individually and queue themselves.
      setStatus(res.ok || res.status < 500 ? 'online' : 'offline');
    } catch {
      setStatus('offline');
    } finally {
      probing = null;
    }
    return status;
  })();
  return probing;
}

/** Wire the heartbeat once, at app start. Idempotent. */
export function startConnectivity(): void {
  if (started) return;
  started = true;

  window.addEventListener('online', () => void probe());
  window.addEventListener('offline', () => setStatus('offline'));

  // A till that was asleep wakes up with a stale verdict; re-check on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void probe();
  });

  // Real traffic is the cheapest heartbeat there is: api() reports every
  // request's outcome, so a working app never needs to probe at all.
  window.addEventListener('pt-reachability', (e) => {
    const reached = (e as CustomEvent<{ reached: boolean }>).detail?.reached;
    if (reached) setStatus('online');
    else if (status === 'online') void probe(); // confirm before crying offline
  });

  rearm();
  void probe();
}

export function getReachability(): Reachability {
  return status;
}

/** True when the API is reachable. Says nothing about being able to talk to it. */
export function isOnline(): boolean {
  return status === 'online';
}

/**
 * True when a request is actually worth making: the API is reachable *and* we
 * hold a token it will accept.
 *
 * A session opened offline against the cached verifier has no tokens. Firing
 * requests from one the moment the WiFi returns would 401, fail to refresh, and
 * dispatch `pt-logout` — throwing the cashier out of a half-rung sale. Instead
 * such a session keeps working from the local catalogue and queue until someone
 * signs in for real (see offlineCreds.ts).
 */
export function canUseServer(): boolean {
  return isOnline() && !!tokenStore.access;
}

export function subscribeReachability(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
