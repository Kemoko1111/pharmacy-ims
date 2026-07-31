import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate, timeOf } from '../lib/format';

interface SaleRow {
  id: string;
  receiptNumber: string;
  branchCode: string;
  cashierName: string;
  status: 'COMPLETED' | 'VOIDED';
  total: string;
  soldAt: string;
  syncedOffline: boolean;
  payments: { method: string }[];
  items: { id: string; productName: string; quantity: number; qtyBase: number; unitName: string; baseUnit?: string }[];
}

export default function SalesHistory() {
  const { user } = useAuth();
  // ADMIN viewing every shop at once: only then does a branch column mean anything.
  const consolidated = user?.activeBranch === null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [voiding, setVoiding] = useState<SaleRow | null>(null);
  const [returning, setReturning] = useState<SaleRow | null>(null);
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';
  const canReturn = isManager || user?.role === 'PHARMACIST';

  const { data } = useQuery({
    queryKey: ['sales', q],
    queryFn: () =>
      api<{ data: SaleRow[]; meta: { total: number } }>(
        `/sales?pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
  });

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold">Sales</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Receipt number…"
          className="flex-1 rounded-lg border border-edge bg-surface px-3 py-2 outline-none focus:border-primary"
        />
      </div>

      {user?.role === 'CASHIER' && (
        <p className="mb-3 text-sm text-ink-muted">Showing your sales for today.</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Receipt</th>
              {consolidated && <th className="px-3 py-2">Branch</th>}
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Cashier</th>
              <th className="px-3 py-2">Items</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((s) => (
              <tr key={s.id} className={`border-b border-edge last:border-0 hover:bg-bg ${s.status === 'VOIDED' ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-mono text-sm">
                  {s.receiptNumber}
                  {s.syncedOffline && <span className="ml-1 text-warn" title="Arrived via offline sync">⇅</span>}
                  {s.status === 'VOIDED' && (
                    <span className="ml-2 rounded bg-danger/15 px-1.5 text-xs font-semibold text-danger">VOID</span>
                  )}
                </td>
                {consolidated && (
                  <td className="px-3 py-2 font-mono text-xs text-ink-muted">{s.branchCode}</td>
                )}
                <td className="px-3 py-2 text-ink-muted">
                  {shortDate(s.soldAt)} {timeOf(s.soldAt)}
                </td>
                <td className="px-3 py-2">{s.cashierName}</td>
                <td className="max-w-64 truncate px-3 py-2 text-sm text-ink-muted">
                  {s.items.filter((i) => i.quantity > 0).map((i) => `${i.quantity}× ${i.productName}`).join(', ')}
                </td>
                <td className="px-3 py-2 text-right font-semibold">{ghs(s.total)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => navigate('/receipt', { state: { saleId: s.id, reprint: true } })}
                    className="text-primary hover:underline"
                  >
                    Reprint
                  </button>
                  {canReturn && s.status === 'COMPLETED' && (
                    <button onClick={() => setReturning(s)} className="ml-3 text-warn hover:underline">
                      Return
                    </button>
                  )}
                  {isManager && s.status === 'COMPLETED' && (
                    <button onClick={() => setVoiding(s)} className="ml-3 text-danger hover:underline">
                      Void
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && <p className="p-6 text-center text-ink-muted">No sales found.</p>}
      </div>

      {voiding && (
        <VoidDialog
          sale={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            queryClient.invalidateQueries({ queryKey: ['sales'] });
          }}
        />
      )}
      {returning && (
        <ReturnDialog
          sale={returning}
          onClose={() => setReturning(null)}
          onDone={() => {
            setReturning(null);
            queryClient.invalidateQueries({ queryKey: ['sales'] });
          }}
        />
      )}
    </div>
  );
}

/** US-14: per-line return with restock choice; the signed-in P/M is the approver. */
function ReturnDialog({ sale, onClose, onDone }: { sale: SaleRow; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState(
    sale.items
      .filter((i) => i.qtyBase > 0)
      .map((i) => ({ saleItemId: i.id, label: `${i.productName} (${i.qtyBase} base units sold)`, max: i.qtyBase, qty: '0', restock: true })),
  );

  const post = useMutation({
    mutationFn: () =>
      api('/returns', {
        method: 'POST',
        body: {
          saleId: sale.id,
          reason,
          items: rows
            .filter((r) => Number(r.qty) > 0)
            .map((r) => ({ saleItemId: r.saleItemId, qtyBase: Number(r.qty), restock: r.restock })),
        },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Return failed'),
  });

  const anyQty = rows.some((r) => Number(r.qty) > 0);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-edge bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-warn">Return against {sale.receiptNumber}</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Approver: <b>{user?.fullName}</b>. Untick restock for damaged/unsellable items.
        </p>

        <div className="mt-4 space-y-2">
          {rows.map((r, idx) => (
            <div key={r.saleItemId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <input
                type="number"
                min="0"
                max={r.max}
                value={r.qty}
                onChange={(e) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))}
                className="w-20 rounded border border-edge bg-bg px-2 py-1 text-center"
              />
              <label className="flex items-center gap-1 text-ink-muted">
                <input
                  type="checkbox"
                  checked={r.restock}
                  onChange={(e) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, restock: e.target.checked } : x)))}
                />
                restock
              </label>
            </div>
          ))}
        </div>

        <label className="mb-1 mt-4 block text-sm font-medium">Reason *</label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-warn"
        />

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button
            disabled={!anyQty || !reason.trim() || post.isPending}
            onClick={() => post.mutate()}
            className="rounded-lg bg-warn px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {post.isPending ? 'Posting…' : 'Post return'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Nothing destructive is one click (wireframes §4): confirm + reason + named approver. */
function VoidDialog({ sale, onClose, onDone }: { sale: SaleRow; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const voidSale = useMutation({
    mutationFn: () => api(`/sales/${sale.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Void failed'),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-edge bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-danger">Void {sale.receiptNumber}?</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Stock returns to its batches; the sale stays in the audit trail. Approver: <b>{user?.fullName}</b>
        </p>
        <label className="mb-1 mt-4 block text-sm font-medium">Reason *</label>
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-danger"
        />
        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button
            disabled={!reason.trim() || voidSale.isPending}
            onClick={() => voidSale.mutate()}
            className="rounded-lg bg-danger px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {voidSale.isPending ? 'Voiding…' : 'Void sale'}
          </button>
        </div>
      </div>
    </div>
  );
}
