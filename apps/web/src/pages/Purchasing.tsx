import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, isQueued } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate } from '../lib/format';
import { ProductPicker, type PickedProduct } from '../components/ProductPicker';

interface PoLine {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  qtyBase: number;
  qtyReceived: number;
  unitCost: string;
}

interface Po {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  expectedDate: string | null;
  createdAt: string;
  items: PoLine[];
}

interface Supplier {
  id: string;
  name: string;
}

interface DirectLine {
  product: PickedProduct | null;
  qty: string;
  unitCost: string;
  batchNumber: string;
  expiryDate: string;
}

const emptyDirectLine = (): DirectLine => ({
  product: null,
  qty: '',
  unitCost: '',
  batchNumber: '',
  expiryDate: '',
});

const STATUS_CLS: Record<string, string> = {
  DRAFT: 'bg-ink-muted/15 text-ink-muted',
  SENT: 'bg-primary/15 text-primary',
  PARTIALLY_RECEIVED: 'bg-warn/15 text-warn',
  RECEIVED: 'bg-ok/15 text-ok',
  CLOSED: 'bg-ink-muted/15 text-ink-muted',
  CANCELLED: 'bg-danger/15 text-danger',
};

export default function Purchasing() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<Po | null>(null);
  const [directReceiving, setDirectReceiving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const { data: pos } = useQuery({
    queryKey: ['pos'],
    queryFn: () => api<{ data: Po[] }>('/purchase-orders?pageSize=50'),
  });
  const { data: suppliers } = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<{ data: Supplier[] }>('/suppliers?pageSize=100'),
  });

  const send = useMutation({
    mutationFn: (id: string) =>
      api(`/purchase-orders/${id}/send`, {
        method: 'POST',
        queue: { label: 'Purchase order sent to supplier' },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pos'] }),
  });

  const draftFromLowStock = useMutation({
    mutationFn: (supplierId: string) =>
      api<Po>('/purchase-orders/from-suggestions', {
        method: 'POST',
        body: { supplierId },
        queue: { label: 'Purchase order drafted from low stock' },
      }),
    onSuccess: (po) => {
      setMessage(
        isQueued(po)
          ? 'Draft saved on this till — it gets its number when the server is reachable.'
          : `Drafted ${po.poNumber} with ${po.items.length} low-stock line(s).`,
      );
      queryClient.invalidateQueries({ queryKey: ['pos'] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Draft failed'),
  });

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Purchasing</h1>
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + New PO
        </button>
        {/* Walk-in deliveries: the rep arrives with stock nobody ordered. */}
        <button
          onClick={() => setDirectReceiving(true)}
          className="rounded-lg border border-primary px-4 py-2 font-semibold text-primary"
        >
          Receive stock (no PO)
        </button>
        <LowStockDraftButton
          suppliers={suppliers?.data ?? []}
          onPick={(id) => draftFromLowStock.mutate(id)}
          busy={draftFromLowStock.isPending}
        />
      </div>

      {message && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-primary/10 px-4 py-2">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} className="font-bold">✕</button>
        </div>
      )}

      <div className="space-y-3">
        {(pos?.data ?? []).map((po) => (
          <div key={po.id} className="rounded-xl border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono font-semibold">{po.poNumber}</span>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[po.status] ?? ''}`}>
                {po.status.replace('_', ' ')}
              </span>
              <span className="text-ink-muted">{po.supplierName}</span>
              <span className="ml-auto text-sm text-ink-muted">{shortDate(po.createdAt)}</span>
              {po.status === 'DRAFT' && (
                <button
                  onClick={() => send.mutate(po.id)}
                  className="rounded border border-primary px-3 py-1 text-sm font-semibold text-primary"
                >
                  Send
                </button>
              )}
              {['SENT', 'PARTIALLY_RECEIVED'].includes(po.status) && (
                <button
                  onClick={() => setReceiving(po)}
                  className="rounded bg-primary px-3 py-1 text-sm font-semibold text-white dark:text-slate-900"
                >
                  Receive
                </button>
              )}
            </div>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {po.items.map((i) => (
                  <tr key={i.id} className="text-ink-muted">
                    <td className="py-0.5">{i.productName}</td>
                    <td className="text-right">
                      {i.qtyReceived}/{i.qtyBase} {i.baseUnit}
                    </td>
                    <td className="w-28 text-right">{ghs(i.unitCost)}/u</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {pos && pos.data.length === 0 && (
          <p className="rounded-xl border border-edge bg-surface p-6 text-center text-ink-muted">
            No purchase orders yet.
          </p>
        )}
      </div>

      {creating && (
        <NewPoDialog
          suppliers={suppliers?.data ?? []}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            queryClient.invalidateQueries({ queryKey: ['pos'] });
          }}
        />
      )}
      {directReceiving && (
        <DirectReceiveDialog
          suppliers={suppliers?.data ?? []}
          onClose={() => setDirectReceiving(false)}
          onDone={(grn) => {
            setDirectReceiving(false);
            setMessage(
              grn
                ? `${grn} posted — stock and ledger updated.`
                : 'Receipt saved on this till — stock updates on the server when the connection is back.',
            );
            queryClient.invalidateQueries({ queryKey: ['batches'] });
          }}
        />
      )}
      {receiving && (
        <ReceiveWizard
          po={receiving}
          onClose={() => setReceiving(null)}
          onDone={(grn) => {
            setReceiving(null);
            setMessage(
              grn
                ? `${grn} posted — stock and ledger updated.`
                : 'Receipt saved on this till — stock updates on the server when the connection is back.',
            );
            queryClient.invalidateQueries({ queryKey: ['pos'] });
            queryClient.invalidateQueries({ queryKey: ['batches'] });
          }}
        />
      )}
    </div>
  );
}

function LowStockDraftButton({
  suppliers,
  onPick,
  busy,
}: {
  suppliers: Supplier[];
  onPick: (id: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy || suppliers.length === 0}
        className="rounded-lg border border-warn px-4 py-2 font-semibold text-warn disabled:opacity-50"
      >
        {busy ? 'Drafting…' : 'Draft from low stock'}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-56 rounded-lg border border-edge bg-surface py-1 shadow-lg">
          {suppliers.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setOpen(false);
                onPick(s.id);
              }}
              className="block w-full px-3 py-2 text-left hover:bg-bg"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewPoDialog({
  suppliers,
  onClose,
  onDone,
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState<{ product: PickedProduct | null; qtyBase: string; unitCost: string }[]>([
    { product: null, qtyBase: '', unitCost: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/purchase-orders', {
        method: 'POST',
        queue: { label: 'Purchase order created' },
        body: {
          supplierId,
          items: lines
            .filter((l) => l.product && Number(l.qtyBase) > 0)
            .map((l) => ({ productId: l.product!.id, qtyBase: Number(l.qtyBase), unitCost: l.unitCost || '0' })),
        },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Create failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">New purchase order</h2>

        <label className="mb-1 mt-3 block text-sm font-medium">Supplier *</label>
        <select required value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={input}>
          <option value="">Select…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <div className="mb-1 mt-4 text-sm font-medium">Lines *</div>
        {lines.map((l, idx) => (
          <div key={idx} className="mb-2 grid grid-cols-[1fr_5rem_6rem_2rem] items-center gap-2">
            <ProductPicker
              value={l.product}
              onPick={(p) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, product: p } : x)))}
            />
            <input
              type="number"
              min="1"
              placeholder="qty"
              value={l.qtyBase}
              onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qtyBase: e.target.value } : x)))}
              className={input}
            />
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="cost/u"
              value={l.unitCost}
              onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unitCost: e.target.value } : x)))}
              className={input}
            />
            <button
              type="button"
              onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
              className="text-danger"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, { product: null, qtyBase: '', unitCost: '' }])}
          className="text-sm font-semibold text-primary"
        >
          + Add line
        </button>

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button
            disabled={create.isPending || !supplierId}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {create.isPending ? 'Creating…' : 'Create draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Receive stock that was never ordered through the system — a rep turns up with
 * a delivery, or the shop buys over the counter from a wholesaler. Posts the
 * same GRN as the PO route with `poId` omitted, so the batch, the weighted-
 * average cost and the RECEIPT movement are all identical; only the paper trail
 * back to a purchase order is missing.
 */
function DirectReceiveDialog({
  suppliers,
  onClose,
  onDone,
}: {
  suppliers: Supplier[];
  onClose: () => void;
  /** null when the receipt was queued offline and has no GRN number yet. */
  onDone: (grn: string | null) => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DirectLine[]>([emptyDirectLine()]);
  const [error, setError] = useState<string | null>(null);

  const ready = useMemo(
    () =>
      lines.filter(
        (l) => l.product && Number(l.qty) > 0 && l.batchNumber.trim() && l.expiryDate,
      ),
    [lines],
  );

  const post = useMutation({
    mutationFn: () =>
      api<{ grnNumber: string }>('/goods-receipts', {
        method: 'POST',
        queue: { label: 'Stock received without a purchase order' },
        body: {
          supplierId,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          items: ready.map((l) => ({
            productId: l.product!.id,
            qtyBase: Number(l.qty),
            unitCost: l.unitCost || '0',
            batchNumber: l.batchNumber.trim(),
            expiryDate: l.expiryDate,
          })),
        },
      }),
    onSuccess: (grn) => onDone(isQueued(grn) ? null : grn.grnNumber),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Posting failed'),
  });

  const patch = (idx: number, next: Partial<DirectLine>) =>
    setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, ...next } : x)));

  const input = 'w-full rounded border border-edge bg-bg px-2 py-1.5 outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">Receive stock without a purchase order</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Goes to the branch you are signed into. Batch number and expiry are required — they are what
          the expiry report runs on.
        </p>

        <label className="mb-1 mt-4 block text-sm font-medium">Supplier *</label>
        <select
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary"
        >
          <option value="">Select…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1">Product *</th>
              <th className="w-20">Qty *</th>
              <th className="w-24">Cost/u</th>
              <th className="w-32">Batch no. *</th>
              <th className="w-36">Expiry *</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={idx}>
                <td className="py-1.5 pr-2">
                  <ProductPicker value={l.product} onPick={(p) => patch(idx, { product: p })} />
                </td>
                <td className="pr-2">
                  <input
                    type="number"
                    min="1"
                    value={l.qty}
                    onChange={(e) => patch(idx, { qty: e.target.value })}
                    className={input}
                  />
                </td>
                <td className="pr-2">
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={l.unitCost}
                    onChange={(e) => patch(idx, { unitCost: e.target.value })}
                    className={input}
                  />
                </td>
                <td className="pr-2">
                  <input
                    value={l.batchNumber}
                    onChange={(e) => patch(idx, { batchNumber: e.target.value })}
                    className={input}
                  />
                </td>
                <td className="pr-2">
                  <input
                    type="date"
                    value={l.expiryDate}
                    onChange={(e) => patch(idx, { expiryDate: e.target.value })}
                    className={input}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)))}
                    disabled={lines.length === 1}
                    className="text-danger disabled:opacity-30"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, emptyDirectLine()])}
          className="mt-2 text-sm font-semibold text-primary"
        >
          + Add line
        </button>

        <label className="mb-1 mt-4 block text-sm font-medium">Notes</label>
        <input
          value={notes}
          placeholder="e.g. invoice number the rep left"
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary"
        />

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          <span className="text-sm text-ink-muted">
            {ready.length} complete line{ready.length === 1 ? '' : 's'} of {lines.length}
          </span>
          <button onClick={onClose} className="ml-auto rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button
            disabled={post.isPending || !supplierId || ready.length === 0}
            onClick={() => post.mutate()}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {post.isPending ? 'Posting…' : 'Post goods receipt'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Screen 7 — 3 steps: per-line qty/batch/expiry → review & post. */
function ReceiveWizard({
  po,
  onClose,
  onDone,
}: {
  po: Po;
  onClose: () => void;
  onDone: (grn: string | null) => void;
}) {
  const { user } = useAuth();
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [allowOver, setAllowOver] = useState(false);
  const [rows, setRows] = useState(
    po.items
      .filter((i) => i.qtyReceived < i.qtyBase)
      .map((i) => ({
        productId: i.productId,
        productName: i.productName,
        baseUnit: i.baseUnit,
        remaining: i.qtyBase - i.qtyReceived,
        qty: String(i.qtyBase - i.qtyReceived),
        unitCost: i.unitCost,
        batchNumber: '',
        expiryDate: '',
      })),
  );

  const included = useMemo(() => rows.filter((r) => Number(r.qty) > 0 && r.batchNumber && r.expiryDate), [rows]);
  const anyOver = useMemo(() => rows.some((r) => Number(r.qty) > r.remaining), [rows]);

  const post = useMutation({
    mutationFn: () =>
      api<{ grnNumber: string }>('/goods-receipts', {
        method: 'POST',
        queue: { label: `Stock received against ${po.poNumber ?? 'a purchase order'}` },
        body: {
          poId: po.id,
          supplierId: po.supplierId,
          items: included.map((r) => ({
            productId: r.productId,
            qtyBase: Number(r.qty),
            unitCost: r.unitCost,
            batchNumber: r.batchNumber,
            expiryDate: r.expiryDate,
          })),
          ...(anyOver && allowOver ? { allowOverReceipt: true } : {}),
        },
      }),
    onSuccess: (grn) => onDone(isQueued(grn) ? null : grn.grnNumber),
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Posting failed');
      setStep(1);
    },
  });

  const input = 'w-full rounded border border-edge bg-bg px-2 py-1.5 outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">
          Receive against {po.poNumber} <span className="font-normal text-ink-muted">— {po.supplierName}</span>
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Step {step} of 2 — {step === 1 ? 'enter deliveries' : 'review & post'}</p>

        {step === 1 && (
          <>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-ink-muted">
                  <th className="py-1">Product</th>
                  <th className="w-24">Qty recv.</th>
                  <th className="w-32">Batch no. *</th>
                  <th className="w-36">Expiry *</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => {
                  const over = Number(r.qty) > r.remaining;
                  return (
                    <tr key={r.productId} className={over ? 'bg-warn/10' : ''}>
                      <td className="py-1.5 pr-2">
                        {r.productName}
                        <span className="ml-1 text-ink-muted">(outstanding {r.remaining} {r.baseUnit})</span>
                        {over && <span className="ml-1 font-semibold text-warn">over-receipt</span>}
                      </td>
                      <td className="pr-2">
                        <input
                          type="number"
                          min="0"
                          value={r.qty}
                          onChange={(e) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, qty: e.target.value } : x)))}
                          className={input}
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          value={r.batchNumber}
                          onChange={(e) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, batchNumber: e.target.value } : x)))}
                          className={input}
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          value={r.expiryDate}
                          onChange={(e) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, expiryDate: e.target.value } : x)))}
                          className={input}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {anyOver && (
              <label className="mt-3 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm">
                <input type="checkbox" checked={allowOver} disabled={!isManager} onChange={(e) => setAllowOver(e.target.checked)} />
                Manager approval for over-receipt {!isManager && <b>(ask a Manager to post this)</b>}
              </label>
            )}
            {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
              <button
                disabled={included.length === 0 || (anyOver && !allowOver)}
                onClick={() => setStep(2)}
                className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
              >
                Review →
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="mt-4 rounded-lg border border-edge p-3 text-sm">
              <div className="mb-2 font-semibold">This will post:</div>
              {included.map((r) => (
                <div key={r.productId} className="flex justify-between py-0.5">
                  <span>
                    +{r.qty} {r.baseUnit} {r.productName} → batch {r.batchNumber} (exp {shortDate(r.expiryDate)})
                  </span>
                  <span className="text-ink-muted">RECEIPT movement</span>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setStep(1)} className="rounded-lg border border-edge px-4 py-2">← Back</button>
              <button
                disabled={post.isPending}
                onClick={() => post.mutate()}
                className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
              >
                {post.isPending ? 'Posting…' : 'Post goods receipt'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
