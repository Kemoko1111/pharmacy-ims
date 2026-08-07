import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate } from '../lib/format';

interface Adjustment {
  id: string;
  productName: string;
  baseUnit: string;
  batchNumber: string;
  qtyDelta: number;
  valueAtCost: string;
  reason: string;
  note: string | null;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

interface ProductOpt {
  id: string;
  name: string;
  baseUnit: string;
  batches?: { id: string; batchNumber: string; qtyOnHand: number; expiryDate: string }[];
}

const REASONS = ['DAMAGE', 'THEFT', 'COUNT_CORRECTION', 'EXPIRY_DISPOSAL', 'SUPPLIER_RETURN', 'OTHER'];

const STATUS_CLS: Record<Adjustment['status'], string> = {
  PENDING_APPROVAL: 'bg-warn/15 text-warn',
  APPROVED: 'bg-ok/15 text-ok',
  REJECTED: 'bg-danger/15 text-danger',
};

export default function Adjustments() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';

  const { data } = useQuery({
    queryKey: ['adjustments', filter],
    queryFn: () =>
      api<{ data: Adjustment[] }>(`/adjustments?pageSize=100${filter ? `&status=${filter}` : ''}`),
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      api(`/adjustments/${id}/approve`, {
        method: 'POST',
        body: { decision },
        queue: { label: `Stock adjustment ${decision.toLowerCase()}` },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['adjustments'] });
      queryClient.invalidateQueries({ queryKey: ['batches'] });
    },
  });

  const pending = (data?.data ?? []).filter((a) => a.status === 'PENDING_APPROVAL').length;

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Stock adjustments</h1>
        {isManager && pending > 0 && (
          <span className="rounded-full bg-warn/15 px-2.5 py-0.5 text-sm font-semibold text-warn">
            {pending} awaiting approval
          </span>
        )}
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="PENDING_APPROVAL">Pending approval</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + Request adjustment
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Product / batch</th>
              <th className="px-3 py-2 text-right">Δ qty</th>
              <th className="px-3 py-2 text-right">Value</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">When</th>
              {isManager && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((a) => (
              <tr key={a.id} className="border-b border-edge last:border-0 hover:bg-bg">
                <td className="px-3 py-2">
                  <span className="font-medium">{a.productName}</span>
                  <span className="ml-2 font-mono text-sm text-ink-muted">{a.batchNumber}</span>
                  {a.note && <div className="text-sm text-ink-muted">{a.note}</div>}
                </td>
                <td className={`px-3 py-2 text-right font-semibold ${a.qtyDelta < 0 ? 'text-danger' : 'text-ok'}`}>
                  {a.qtyDelta > 0 ? '+' : ''}{a.qtyDelta} {a.baseUnit}
                </td>
                <td className="px-3 py-2 text-right">{ghs(a.valueAtCost)}</td>
                <td className="px-3 py-2 text-sm">{a.reason.replace('_', ' ')}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[a.status]}`}>
                    {a.status.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm text-ink-muted">{shortDate(a.createdAt)}</td>
                {isManager && (
                  <td className="px-3 py-2 text-right">
                    {a.status === 'PENDING_APPROVAL' && (
                      <>
                        <button
                          onClick={() => decide.mutate({ id: a.id, decision: 'APPROVED' })}
                          className="font-semibold text-ok hover:underline"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => decide.mutate({ id: a.id, decision: 'REJECTED' })}
                          className="ml-3 font-semibold text-danger hover:underline"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && (
          <p className="p-6 text-center text-ink-muted">No adjustments recorded.</p>
        )}
      </div>

      {creating && (
        <NewAdjustmentDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['adjustments'] });
            queryClient.invalidateQueries({ queryKey: ['batches'] });
          }}
        />
      )}
    </div>
  );
}

function NewAdjustmentDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [productId, setProductId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [direction, setDirection] = useState<'-' | '+'>('-');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('DAMAGE');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: products } = useQuery({
    queryKey: ['product-opts'],
    queryFn: () => api<{ data: ProductOpt[] }>('/products?pageSize=200'),
  });
  const { data: detail } = useQuery({
    queryKey: ['product-detail', productId],
    queryFn: () => api<ProductOpt>(`/products/${productId}`),
    enabled: !!productId,
  });

  const create = useMutation({
    mutationFn: () =>
      api('/adjustments', {
        method: 'POST',
        body: {
          productId,
          batchId,
          qtyDelta: (direction === '-' ? -1 : 1) * Number(qty),
          reason,
          ...(note ? { note } : {}),
        },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Request failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';
  const label = 'mb-1 mt-3 block text-sm font-medium';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">Request stock adjustment</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Small adjustments post immediately; larger ones wait for Manager approval.
        </p>

        <label className={label}>Product *</label>
        <select required value={productId} onChange={(e) => { setProductId(e.target.value); setBatchId(''); }} className={input}>
          <option value="">Select…</option>
          {(products?.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <label className={label}>Batch *</label>
        <select required value={batchId} onChange={(e) => setBatchId(e.target.value)} className={input} disabled={!productId}>
          <option value="">Select…</option>
          {(detail?.batches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.batchNumber} — {b.qtyOnHand} on hand, exp {b.expiryDate}
            </option>
          ))}
        </select>

        <div className="grid grid-cols-[6rem_1fr] gap-3">
          <div>
            <label className={label}>Direction</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as '-' | '+')} className={input}>
              <option value="-">− remove</option>
              <option value="+">+ add</option>
            </select>
          </div>
          <div>
            <label className={label}>Quantity (base units) *</label>
            <input required type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} className={input} />
          </div>
        </div>

        <label className={label}>Reason *</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className={input}>
          {REASONS.map((r) => (
            <option key={r} value={r}>{r.replace('_', ' ')}</option>
          ))}
        </select>

        <label className={label}>Note</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} className={input} />

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button
            disabled={create.isPending || !batchId || !qty}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {create.isPending ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>
    </div>
  );
}
