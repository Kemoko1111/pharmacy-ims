import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { refreshSnapshot } from '../lib/offline';
import { useClickAway } from '../lib/useClickAway';

/**
 * Which shop the till is working in (ADR-010).
 *
 * Branch lives in the signed token, so switching is a server round-trip, not a
 * local toggle. Everything cached for the old branch — react-query results and
 * the offline catalogue — is thrown away afterwards, because stock figures do
 * not carry across.
 *
 * Rendered as static text when the user only has one branch: a control that can
 * only do one thing is noise at a till.
 */
export function BranchSwitcher() {
  const { user, switchBranch } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, open, useCallback(() => setOpen(false), []));

  if (!user) return null;

  const branches = user.branches ?? [];
  const active = user.activeBranch;
  const isAdmin = user.role === 'ADMIN';
  const canSwitch = branches.length > 1 || isAdmin;

  const label = active ? active.code : 'All branches';

  if (!canSwitch) {
    return (
      <span
        className="rounded-full bg-primary/10 px-2 py-0.5 text-sm font-semibold text-primary"
        title={active?.name ?? undefined}
      >
        ⌂ {label}
      </span>
    );
  }

  const choose = async (branchId: string | null) => {
    if (branchId === (active?.id ?? null)) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await switchBranch(branchId);
      // Anything already fetched describes the previous branch.
      queryClient.clear();
      await refreshSnapshot().catch(() => {});
      setOpen(false);
    } catch {
      setError('Could not switch branch');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm font-semibold text-primary hover:bg-primary/20 disabled:opacity-60"
        title={active?.name ?? 'Viewing every branch'}
      >
        ⌂ {busy ? '…' : label} ▾
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-1 min-w-52 rounded border border-edge bg-surface py-1 shadow-lg"
        >
          {branches.map((b) => (
            <button
              key={b.id}
              role="option"
              aria-selected={b.id === active?.id}
              onClick={() => choose(b.id)}
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-primary/10 ${
                b.id === active?.id ? 'font-semibold text-primary' : 'text-ink'
              }`}
            >
              <span className="font-mono text-xs opacity-70">{b.code}</span> {b.name}
            </button>
          ))}

          {isAdmin && (
            <>
              <div className="my-1 border-t border-edge" />
              <button
                role="option"
                aria-selected={active === null}
                onClick={() => choose(null)}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-primary/10 ${
                  active === null ? 'font-semibold text-primary' : 'text-ink'
                }`}
              >
                All branches
                <span className="block text-xs text-ink-muted">
                  Consolidated reporting — read only
                </span>
              </button>
            </>
          )}

          {error && <p className="px-3 py-2 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
