import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetMutation, pendingMutations, type QueuedMutation } from '../lib/offline';
import { useClickAway } from '../lib/useClickAway';
import { shortDate, timeOf } from '../lib/format';

/**
 * What this till has done that the server has not seen yet (ADR-013).
 *
 * Offline writes are queued rather than applied locally, so the screens keep
 * showing the last synced state. That is the honest choice — a local edit
 * displayed as fact is a claim we cannot back until the server accepts it — but
 * it leaves the cashier with no evidence their work exists. This is that
 * evidence: what was done, when, and what the server said if it refused.
 */
export function PendingChanges({ pending, rejected }: { pending: number; rejected: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<QueuedMutation[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  useClickAway(boxRef, open, useCallback(() => setOpen(false), []));

  const refresh = useCallback(() => {
    pendingMutations()
      .then(setRows)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    window.addEventListener('pt-mutations-changed', refresh);
    return () => window.removeEventListener('pt-mutations-changed', refresh);
  }, [refresh]);

  if (pending === 0 && rejected === 0) return null;

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Changes made on this till that the server has not accepted yet"
        className={`rounded-full px-2 py-0.5 text-sm font-semibold ${
          rejected > 0 ? 'bg-danger/15 text-danger' : 'bg-warn/20 text-warn'
        }`}
      >
        ✎ {pending + rejected} {rejected > 0 ? 'change(s) — action needed' : 'change(s) waiting'}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-96 w-96 overflow-auto rounded-xl border border-edge bg-surface p-3 shadow-lg">
          <p className="mb-2 text-sm text-ink-muted">
            Saved on this till. Screens still show the last synced data until these go up.
          </p>
          {rows.length === 0 && <p className="py-2 text-sm text-ink-muted">Nothing waiting.</p>}
          {rows.map((m) => (
            <div key={m.opId} className="border-t border-edge py-2 first:border-0">
              <div className="flex items-start gap-2">
                <span className="flex-1 text-sm font-medium">{m.label}</span>
                <span className="text-xs text-ink-muted">
                  {shortDate(m.queuedAt)} {timeOf(m.queuedAt)}
                </span>
              </div>
              {m.rejectedAt ? (
                <div className="mt-1 rounded bg-danger/10 px-2 py-1 text-xs text-danger">
                  <p>Refused by the server: {m.lastError}</p>
                  <p className="mt-1">
                    This was not applied. Redo it on this screen if it is still needed.
                  </p>
                  <button
                    onClick={() => forgetMutation(m.opId)}
                    className="mt-1 font-semibold underline"
                  >
                    Dismiss
                  </button>
                </div>
              ) : (
                <p className="mt-0.5 text-xs text-ink-muted">
                  Waiting to sync{m.attempts > 0 ? ` · ${m.attempts} attempt(s)` : ''}
                  {m.lastError ? ` · ${m.lastError}` : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
