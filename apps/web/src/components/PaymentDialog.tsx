import { useEffect, useRef, useState } from 'react';
import { fromP, ghs, toP } from '../lib/format';

interface Props {
  totalP: number;
  onConfirm: (p: { method: 'CASH' | 'MOMO'; tenderedP: number | null }) => Promise<void>;
  onClose: () => void;
}

/** F4 payment: tender buttons, amount-tendered keypad, change in 40px type. */
export function PaymentDialog({ totalP, onConfirm, onClose }: Props) {
  const [method, setMethod] = useState<'CASH' | 'MOMO'>('CASH');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const tenderedP = tendered === '' ? null : toP(tendered);
  const changeP = tenderedP !== null ? tenderedP - totalP : null;
  const canConfirm = method === 'MOMO' || tenderedP === null || tenderedP >= totalP;

  useEffect(() => inputRef.current?.focus(), []);

  const confirm = async () => {
    if (!canConfirm || busy) return;
    setBusy(true);
    try {
      await onConfirm({ method, tenderedP: method === 'CASH' ? tenderedP : null });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void confirm();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, tendered, busy]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-edge bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center text-sm uppercase tracking-wide text-ink-muted">Amount due</div>
        <div className="text-center text-4xl font-bold">{ghs(fromP(totalP))}</div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          {(['CASH', 'MOMO'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`rounded-lg border py-3 text-lg font-semibold ${
                method === m ? 'border-primary bg-primary/15 text-primary' : 'border-edge'
              }`}
            >
              {m === 'CASH' ? 'Cash' : 'MoMo'}
            </button>
          ))}
        </div>

        {method === 'CASH' && (
          <>
            <label className="mt-4 block text-sm font-medium">Amount tendered</label>
            <input
              ref={inputRef}
              type="number"
              min={0}
              step="0.5"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              placeholder={fromP(totalP)}
              className="mt-1 w-full rounded-lg border border-edge bg-bg px-3 py-3 text-center text-2xl outline-none focus:border-primary"
            />
            {changeP !== null && changeP >= 0 && (
              <div className="mt-3 text-center">
                <span className="text-sm uppercase tracking-wide text-ink-muted">Change</span>
                <div className="text-[40px] font-bold leading-tight text-ok">{ghs(fromP(changeP))}</div>
              </div>
            )}
            {changeP !== null && changeP < 0 && (
              <p className="mt-3 text-center font-semibold text-danger">
                Short by {ghs(fromP(-changeP))}
              </p>
            )}
          </>
        )}

        <button
          onClick={confirm}
          disabled={!canConfirm || busy}
          className="mt-5 w-full rounded-lg bg-primary py-3 text-lg font-bold text-white disabled:opacity-40 dark:text-slate-900"
        >
          {busy ? 'Completing…' : 'Enter · Confirm & print'}
        </button>
        <button onClick={onClose} className="mt-2 w-full rounded-lg border border-edge py-2 text-ink-muted">
          Esc · Cancel
        </button>
      </div>
    </div>
  );
}
