import { useCallback, useEffect, useState } from 'react';
import { getLastSyncedAt, queueSummary, type QueueSummary } from './offline';
import { getReachability, subscribeReachability } from './connectivity';
import { getSyncState, syncNow, type SyncState } from './sync';

const EMPTY: QueueSummary = { pending: 0, deferred: 0, stuck: 0, lastError: null };

/**
 * Everything the status bar needs about the link and the queue. The polling,
 * draining and backoff all live in `connectivity` / `sync` as singletons — this
 * hook only subscribes, so mounting it in several places costs nothing.
 */
export function useOnline() {
  const [online, setOnline] = useState(getReachability() === 'online');
  const [queue, setQueue] = useState<QueueSummary>(EMPTY);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>(getSyncState);

  useEffect(() => {
    const refreshQueue = () => queueSummary().then(setQueue).catch(() => {});
    const refreshSynced = () => getLastSyncedAt().then(setLastSyncedAt).catch(() => {});
    refreshQueue();
    refreshSynced();

    const unsubscribe = subscribeReachability((status) => setOnline(status === 'online'));
    const onSyncState = (e: Event) => {
      setSync((e as CustomEvent<SyncState>).detail);
      refreshQueue();
    };

    window.addEventListener('pt-queue-changed', refreshQueue);
    window.addEventListener('pt-synced', refreshSynced);
    window.addEventListener('pt-sync-state', onSyncState);
    return () => {
      unsubscribe();
      window.removeEventListener('pt-queue-changed', refreshQueue);
      window.removeEventListener('pt-synced', refreshSynced);
      window.removeEventListener('pt-sync-state', onSyncState);
    };
  }, []);

  return {
    online,
    /** Sales expected to sync — what the "unsynced" badge counts. */
    unsynced: queue.pending,
    /** Queued against another branch; needs a switch back, not a retry. */
    deferred: queue.deferred,
    /** Refused repeatedly — a manager has to look at these. */
    stuck: queue.stuck,
    queueError: queue.lastError,
    lastSyncedAt,
    syncing: sync.syncing,
    syncError: sync.lastError,
    /** Manual "Sync now" for a cashier who does not want to wait for backoff. */
    retry: useCallback(() => void syncNow('manual'), []),
  };
}
