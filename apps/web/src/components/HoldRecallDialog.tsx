import { useEffect, useState } from 'react';
import { v7 as uuidv7 } from '../lib/uuid';
import { db, getActiveBranch, HeldSale } from '../lib/offline';
import { CartLine, cartTotals, useCart } from '../stores/cart';
import { fromP, ghs } from '../lib/format';
import { timeOf } from '../lib/format';

interface Props {
  cashierId: string;
  onClose: () => void;
}

/** F9 — park the current sale / recall a parked one (wireframes §Keyboard). */
export function HoldRecallDialog({ cashierId, onClose }: Props) {
  const cart = useCart();
  const [held, setHeld] = useState<HeldSale[]>([]);

  // A cart parked at one shop must not be recallable at another (ADR-010).
  const refresh = () =>
    db.heldSales
      .where('cashierId')
      .equals(cashierId)
      .and((h) => h.branchId === (getActiveBranch() ?? ''))
      .sortBy('heldAt')
      .then(setHeld);
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const holdCurrent = async () => {
    if (cart.lines.length === 0) return;
    const first = cart.lines[0];
    await db.heldSales.put({
      id: uuidv7(),
      branchId: getActiveBranch() ?? '',
      heldAt: new Date().toISOString(),
      cashierId,
      label:
        cart.lines.length === 1
          ? first.name
          : `${first.name} +${cart.lines.length - 1} more`,
      lines: cart.lines,
    });
    cart.clear();
    await refresh();
  };

  const recall = async (h: HeldSale) => {
    if (cart.lines.length > 0) return; // hold the current sale first
    cart.setLines(h.lines as CartLine[]);
    await db.heldSales.delete(h.id);
    onClose();
  };

  const discard = async (h: HeldSale) => {
    if (!confirm(`Discard held sale "${h.label}"?`)) return;
    await db.heldSales.delete(h.id);
    await refresh();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-edge bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">Hold / recall (F9)</h2>

        {cart.lines.length > 0 && (
          <button
            onClick={holdCurrent}
            className="mt-3 w-full rounded-lg bg-warn py-2.5 font-semibold text-white dark:text-slate-900"
          >
            Hold current sale ({cart.lines.length} line{cart.lines.length > 1 ? 's' : ''} ·{' '}
            {ghs(fromP(cartTotals(cart.lines).totalP))})
          </button>
        )}

        <div className="mt-4">
          <div className="text-sm font-semibold text-ink-muted">Parked sales</div>
          {held.length === 0 && <p className="py-4 text-center text-sm text-ink-muted">Nothing on hold.</p>}
          {held.map((h) => (
            <div key={h.id} className="flex items-center gap-2 border-b border-edge py-2 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{h.label}</div>
                <div className="text-xs text-ink-muted">
                  held {timeOf(h.heldAt)} · {ghs(fromP(cartTotals(h.lines as CartLine[]).totalP))}
                </div>
              </div>
              <button
                onClick={() => recall(h)}
                disabled={cart.lines.length > 0}
                title={cart.lines.length > 0 ? 'Hold the current sale first' : 'Recall to the till'}
                className="rounded bg-primary px-3 py-1 text-sm font-semibold text-white disabled:opacity-40 dark:text-slate-900"
              >
                Recall
              </button>
              <button onClick={() => discard(h)} className="text-danger" title="Discard">✕</button>
            </div>
          ))}
        </div>

        <button onClick={onClose} className="mt-4 w-full rounded-lg border border-edge py-2 text-ink-muted">
          Esc · Close
        </button>
      </div>
    </div>
  );
}
