import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fromP, ghs, toP } from '../lib/format';

interface Props {
  totalP: number;
  onConfirm: (p: {
    method: 'CASH' | 'MOMO';
    tenderedP: number | null;
    customerId: string | null;
  }) => Promise<void>;
  onClose: () => void;
}

interface CustomerHit {
  id: string;
  fullName: string;
  phone: string | null;
}

/** F4 payment: tender buttons, amount-tendered keypad, change in 40px type. */
export function PaymentDialog({ totalP, onConfirm, onClose }: Props) {
  const { user } = useAuth();
  const [method, setMethod] = useState<'CASH' | 'MOMO'>('CASH');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [customerQ, setCustomerQ] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Customer records are P/M-only (US-15 / Act 843); cashiers sell anonymous
  const canAttachCustomer = ['PHARMACIST', 'MANAGER', 'ADMIN'].includes(user?.role ?? '');
  const { data: customerHits } = useQuery({
    queryKey: ['customer-search', customerQ],
    queryFn: () => api<{ data: CustomerHit[] }>(`/customers?q=${encodeURIComponent(customerQ)}&pageSize=5`),
    enabled: canAttachCustomer && customerQ.length >= 2 && !customer,
  });

  const tenderedP = tendered === '' ? null : toP(tendered);
  const changeP = tenderedP !== null ? tenderedP - totalP : null;
  const canConfirm = method === 'MOMO' || tenderedP === null || tenderedP >= totalP;

  useEffect(() => inputRef.current?.focus(), []);

  const confirm = async () => {
    if (!canConfirm || busy) return;
    setBusy(true);
    try {
      await onConfirm({
        method,
        tenderedP: method === 'CASH' ? tenderedP : null,
        customerId: customer?.id ?? null,
      });
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
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
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

        {canAttachCustomer && (
          <div className="relative mt-4">
            <label className="mb-1 block text-sm font-medium text-ink-muted">Customer (optional)</label>
            {customer ? (
              <div className="flex items-center justify-between rounded-lg border border-edge bg-bg px-3 py-2">
                <span>
                  {customer.fullName} {customer.phone && <span className="text-ink-muted">({customer.phone})</span>}
                </span>
                <button onClick={() => setCustomer(null)} className="text-danger">✕</button>
              </div>
            ) : (
              <>
                <input
                  value={customerQ}
                  onChange={(e) => setCustomerQ(e.target.value)}
                  placeholder="Search name or phone…"
                  className="w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
                />
                {(customerHits?.data ?? []).length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-edge bg-surface shadow-lg">
                    {customerHits!.data.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setCustomer(c)}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-bg"
                      >
                        {c.fullName} {c.phone && <span className="text-ink-muted">({c.phone})</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
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
