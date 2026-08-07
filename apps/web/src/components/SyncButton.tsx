import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { syncEverything, type ManualSyncOutcome } from '../lib/sync';
import { useOnline } from '../lib/useOnline';
import { syncedLabel } from '../lib/format';

/**
 * "Sync now", for a manager who wants to know *now* rather than trust that the
 * background engine got round to it (ADR-013).
 *
 * The engine already drains on start, on recovery, on refocus and on a timer,
 * so this button is not what makes syncing work. It is what makes syncing
 * *visible*: the shop's link goes down often enough that "has my stock count
 * reached the server?" is a real question, and until now the only answer on
 * screen was a badge that says ONLINE — which is about the link, not the data.
 *
 * Pressing it pushes what is queued, pulls the catalogue, and refetches the
 * screens currently open. It always reports what happened, including when the
 * answer is "nothing was sent, because the server did not answer" — silence
 * after a button press reads as success, and here that would be a lie.
 */
export function SyncButton() {
  const queryClient = useQueryClient();
  const { lastSyncedAt, unsynced, unsentWrites, rejectedWrites, stuck } = useOnline();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waiting = unsynced + unsentWrites;
  const needsAttention = rejectedWrites + stuck;

  // The outcome describes one press; the "synced HH:MM" line underneath is the
  // durable truth. Clearing it keeps a stale "Up to date" from being read an
  // hour later as if it still applied.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function report(message: string) {
    setResult(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), 10_000);
  }

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const outcome = await syncEverything();
      if (outcome.status === 'synced') {
        // Every screen reads through api(), which re-caches what the server
        // returns, so refetching the open queries is what makes the pull half
        // of "sync" real — and it refills the offline cache at the same time.
        await queryClient.invalidateQueries();
      }
      report(describe(outcome));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={run}
        disabled={busy}
        title="Send anything saved on this till to the server, then refresh what is on screen"
        className="rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-bg disabled:opacity-60"
      >
        {busy ? '⇅ Syncing…' : '⇅ Sync now'}
        {waiting > 0 && !busy && (
          <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 text-xs text-warn">{waiting}</span>
        )}
      </button>
      <span
        className={`text-xs ${result ? 'font-medium text-ink' : 'text-ink-muted'}`}
        role="status"
        aria-live="polite"
      >
        {result ?? `Last ${syncedLabel(lastSyncedAt)}`}
      </span>
      {needsAttention > 0 && !busy && (
        <span className="text-xs text-danger">
          {needsAttention} item(s) the server refused — see “change(s) waiting” above
        </span>
      )}
    </div>
  );
}

function describe(outcome: ManualSyncOutcome): string {
  switch (outcome.status) {
    case 'offline':
      return 'No answer from the server — nothing was sent. Saved work is safe on this till.';
    case 'signin-required':
      return 'Signed in offline — sign in again to sync.';
    case 'busy':
      return 'A sync is already running…';
    case 'error':
      return `Sync failed: ${outcome.message}`;
    case 'synced': {
      const parts: string[] = [];
      if (outcome.sent > 0) parts.push(`Sent ${outcome.sent} change(s)`);
      if (outcome.refused > 0) parts.push(`${outcome.refused} refused`);
      if (outcome.waiting > 0) parts.push(`${outcome.waiting} still waiting`);
      return parts.length === 0 ? 'Up to date.' : `${parts.join(' · ')}.`;
    }
  }
}
