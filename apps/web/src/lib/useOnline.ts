import { useCallback, useEffect, useState } from 'react';
import {
  getLastSyncedAt,
  mutationQueueSummary,
  queueSummary,
  type MutationQueueSummary,
  type QueueSummary,
} from './offline';
import { getReachability, subscribeReachability } from './connectivity';
import { getStaleReadAt } from './offlineCache';
import { getSyncState, syncNow, type SyncState } from './sync';

const EMPTY: QueueSummary = { pending: 0, deferred: 0, stuck: 0, lastError: null };
const NO_WRITES: MutationQueueSummary = { pending: 0, rejected: 0 };

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
  const [staleAt, setStaleAt] = useState<string | null>(getStaleReadAt);
  const [writes, setWrites] = useState<MutationQueueSummary>(NO_WRITES);

  useEffect(() => {
    const refreshQueue = () => queueSummary().then(setQueue).catch(() => {});
    const refreshSynced = () => getLastSyncedAt().then(setLastSyncedAt).catch(() => {});
    const refreshWrites = () => mutationQueueSummary().then(setWrites).catch(() => {});
    refreshQueue();
    refreshSynced();
    refreshWrites();

    const onStale = (e: Event) => setStaleAt((e as CustomEvent<{ at: string | null }>).detail.at);
    window.addEventListener('pt-mutations-changed', refreshWrites);
    window.addEventListener('pt-stale-read', onStale);

    const unsubscribe = subscribeReachability((status) => setOnline(status === 'online'));
    const onSyncState = (e: Event) => {
      setSync((e as CustomEvent<SyncState>).detail);
      refreshQueue();
      refreshWrites();
    };

    window.addEventListener('pt-queue-changed', refreshQueue);
    window.addEventListener('pt-synced', refreshSynced);
    window.addEventListener('pt-sync-state', onSyncState);
    return () => {
      unsubscribe();
      window.removeEventListener('pt-queue-changed', refreshQueue);
      window.removeEventListener('pt-synced', refreshSynced);
      window.removeEventListener('pt-sync-state', onSyncState);
      window.removeEventListener('pt-stale-read', onStale);
      window.removeEventListener('pt-mutations-changed', refreshWrites);
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
    /**
     * When the data on screen was fetched, if any of it came off disk rather
     * than the server. Null means everything shown is live (ADR-013).
     */
    staleAt,
    /** Writes made offline that have not reached the server yet (ADR-013). */
    unsentWrites: writes.pending,
    /** Writes the server refused outright — a person has to deal with these. */
    rejectedWrites: writes.rejected,
    syncing: sync.syncing,
    syncError: sync.lastError,
    /** Manual "Sync now" for a cashier who does not want to wait for backoff. */
    retry: useCallback(() => void syncNow('manual'), []),
  };
}
