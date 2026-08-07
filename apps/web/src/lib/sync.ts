/**
 * The sync engine (ADR-006).
 *
 * The queue used to drain from exactly one trigger: the browser's `online`
 * event. That event only fires on a *transition*, which is the one moment a
 * till often misses — close the laptop with sales queued, open it the next
 * morning already on WiFi, and no transition ever happens. The sales sat there
 * until someone pulled the network cable and plugged it back in.
 *
 * So a drain is attempted on every occasion that could plausibly change the
 * outcome: app start, reachability recovery, a new sale being queued, the tab
 * coming back to the foreground, and a backoff timer while anything is still
 * waiting. All of them funnel into `drainQueue()`, which is idempotent server-
 * side and de-duplicated client-side.
 */
import {
  drainQueue,
  forgetMutation,
  noteMutationAttempt,
  pendingMutations,
  queueSummary,
  refreshSnapshot,
  rejectMutation,
} from './offline';
import { ApiError, api, NetworkError } from './api';
import { canUseServer, getReachability, probe, subscribeReachability } from './connectivity';

export interface SyncState {
  syncing: boolean;
  /** Why the last drain failed, if it did. Cleared by the next success. */
  lastError: string | null;
  /** Consecutive failures — drives the backoff. */
  failures: number;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let state: SyncState = { syncing: false, lastError: null, failures: 0 };
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function emit() {
  window.dispatchEvent(new CustomEvent('pt-sync-state', { detail: { ...state } }));
}

export function getSyncState(): SyncState {
  return { ...state };
}

/** 5s, 10s, 20s … capped at 5 min, so a long outage stops hammering the radio. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

function scheduleRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void syncNow('retry');
  }, backoffMs(state.failures));
}

function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/**
 * Attempt a drain. Safe to call from anywhere, as often as you like: it no-ops
 * when there is nothing queued for this branch or when the API is known to be
 * unreachable, and concurrent calls share one request.
 */
export async function syncNow(reason: string): Promise<void> {
  if (state.syncing) return;

  const summary = await queueSummary();
  const writes = (await pendingMutations()).filter((m) => !m.rejectedAt).length;
  if (summary.pending === 0 && summary.stuck === 0 && writes === 0) {
    cancelRetry();
    if (state.failures !== 0 || state.lastError) {
      state = { syncing: false, lastError: null, failures: 0 };
      emit();
    }
    return;
  }

  // Don't burn a request on a link we already know is down; the reachability
  // heartbeat will call back here the moment it recovers. And don't post from a
  // session opened offline — it has no token, so this would 401 and log the
  // cashier out. Those sales wait for a real sign-in.
  if (!canUseServer()) {
    if (getReachability() === 'offline' && navigator.onLine) void probe();
    return;
  }

  state = { ...state, syncing: true };
  emit();
  try {
    // Sales first: the money is the part the shop cannot afford to lose.
    const res = await drainQueue();
    await drainMutations();
    state = {
      syncing: false,
      // A per-sale refusal is not a transport failure: stop the backoff, but
      // keep the message so the badge can explain itself.
      lastError: res.failed > 0 ? `${res.failed} sale(s) refused by the server` : null,
      failures: 0,
    };
    emit();
    const left = await queueSummary();
    const writesLeft = (await pendingMutations()).filter((m) => !m.rejectedAt).length;
    if (left.pending > 0 || writesLeft > 0) scheduleRetry();
  } catch (err) {
    state = {
      syncing: false,
      lastError: err instanceof Error ? err.message : 'Sync failed',
      failures: state.failures + 1,
    };
    emit();
    scheduleRetry();
    void probe(); // the failure may mean the link went down mid-drain
  }
  void reason; // kept for future telemetry; the call sites document themselves
}


/**
 * Send queued writes up, oldest first (ADR-013).
 *
 * Order matters — a product created offline and then edited must reach the
 * server that way round — so this is strictly sequential and stops at the first
 * transport failure rather than skipping ahead.
 *
 * Each write carries its opId as the Idempotency-Key, so a retry after a lost
 * answer replays the original response instead of posting twice.
 */
async function drainMutations(): Promise<void> {
  const rows = (await pendingMutations()).filter((m) => !m.rejectedAt);

  for (const m of rows) {
    try {
      await api(m.path, {
        method: m.method,
        body: m.body,
        queue: false, // already queued; a failure here must not re-queue it
        idempotencyKey: m.opId,
      });
      await forgetMutation(m.opId);
    } catch (err) {
      if (err instanceof NetworkError) {
        // The link went down again mid-drain. Everything after this one still
        // has to go in order, so stop rather than skip.
        await noteMutationAttempt(m.opId, 'Connection lost while syncing');
        return;
      }
      if (err instanceof ApiError) {
        // The server answered and refused. Retrying changes nothing; a person
        // has to look at it. Keep going so one bad row cannot strand the rest.
        await rejectMutation(m.opId, err.message);
        continue;
      }
      await noteMutationAttempt(m.opId, err instanceof Error ? err.message : 'Sync failed');
      return;
    }
  }
}

/** Wire every drain trigger once, at app start. Idempotent. */
export function startSync(): void {
  if (started) return;
  started = true;

  // Recovery: the only trigger that used to exist, now one of several.
  subscribeReachability((status) => {
    if (status !== 'online') return;
    cancelRetry();
    state = { ...state, failures: 0 };
    void syncNow('reachability-up');
    // Stock moved while the till was blind; refresh before the next sale
    // prices or reserves anything against a stale snapshot.
    refreshSnapshot().catch(() => {});
  });

  // A sale was just queued — try immediately rather than waiting for a timer.
  window.addEventListener('pt-queue-changed', () => void syncNow('queue-changed'));
  window.addEventListener('pt-mutations-changed', () => void syncNow('mutations-changed'));

  // Back from a locked screen or another tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow('visible');
  });

  // The case the old code could not handle: already online at startup with a
  // queue left over from the last shift.
  void syncNow('startup');
}
