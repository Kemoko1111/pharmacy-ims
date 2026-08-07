import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Branch } from '@pharmatrack/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate } from '../lib/format';

interface TransferItem {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  batchNumber: string;
  expiryDate: string;
  qtyBase: number;
  qtyReceived: number;
  unitCost: string;
}

interface Transfer {
  id: string;
  transferNumber: string;
  fromBranchId: string;
  fromBranchCode: string;
  toBranchId: string;
  toBranchCode: string;
  status: 'DRAFT' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
  notes: string | null;
  dispatchedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  items: TransferItem[];
}

interface BatchOpt {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  batchNumber: string;
  expiryDate: string;
  qtyOnHand: number;
}

const STATUS_CLS: Record<Transfer['status'], string> = {
  DRAFT: 'bg-ink/10 text-ink-muted',
  IN_TRANSIT: 'bg-warn/15 text-warn',
  RECEIVED: 'bg-ok/15 text-ok',
  CANCELLED: 'bg-danger/15 text-danger',
};

/**
 * Stock transfers between shops (ADR-010).
 *
 * A transfer is two one-sided actions, so the page shows a branch only the half
 * it can act on: you dispatch what you are sending, and receive what is coming
 * to you. Nothing here can move another branch's stock.
 */
export default function Transfers() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const myBranchId = user?.activeBranch?.id ?? null;

  const { data } = useQuery({
    queryKey: ['transfers'],
    queryFn: () => api<{ data: Transfer[] }>('/transfers?pageSize=100'),
  });

  const { data: inTransit } = useQuery({
    queryKey: ['transfers', 'in-transit'],
    queryFn: () => api<{ rows: unknown[]; totalValue: string }>('/transfers/in-transit'),
    enabled: user?.role === 'MANAGER' || user?.role === 'ADMIN',
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['transfers'] });
    queryClient.invalidateQueries({ queryKey: ['batches'] });
    queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'dispatch' | 'cancel' }) =>
      api(`/transfers/${id}/${action}`, {
        method: 'POST',
        body: {},
        queue: { label: `Stock transfer ${action}` },
      }),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Action failed'),
  });

  const rows = data?.data ?? [];
  const outgoing = rows.filter((t) => t.fromBranchId === myBranchId);
  const incoming = rows.filter((t) => t.toBranchId === myBranchId);

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Stock transfers</h1>
        {inTransit && Number(inTransit.totalValue) > 0 && (
          <span
            className="rounded-full bg-warn/15 px-2.5 py-0.5 text-sm font-semibold text-warn"
            title="Dispatched but not yet received — still the sending branch's asset"
          >
            {ghs(inTransit.totalValue)} in transit
          </span>
        )}
        <button
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
          className="ml-auto rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + New transfer
        </button>
      </div>

      {error && <p className="mb-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <Section
        title="Coming to us"
        empty="Nothing on its way."
        rows={incoming}
        render={(t) => (
          <>
            <StatusPill status={t.status} />
            {t.status === 'IN_TRANSIT' && (
              <button
                onClick={() => {
                  setError(null);
                  setReceiving(t);
                }}
                className="ml-3 font-semibold text-primary hover:underline"
              >
                Receive
              </button>
            )}
          </>
        )}
      />

      <Section
        title="Sending out"
        empty="No outgoing transfers."
        rows={outgoing}
        render={(t) => (
          <>
            <StatusPill status={t.status} />
            {t.status === 'DRAFT' && (
              <>
                <button
                  onClick={() => act.mutate({ id: t.id, action: 'dispatch' })}
                  disabled={act.isPending}
                  className="ml-3 font-semibold text-primary hover:underline disabled:opacity-50"
                >
                  Dispatch
                </button>
                <button
                  onClick={() => act.mutate({ id: t.id, action: 'cancel' })}
                  disabled={act.isPending}
                  className="ml-3 text-danger hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </>
            )}
            {t.status === 'IN_TRANSIT' && (
              <span className="ml-3 text-sm text-ink-muted">awaiting receipt</span>
            )}
          </>
        )}
      />

      {creating && (
        <CreateTransferDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}

      {receiving && (
        <ReceiveTransferDialog
          transfer={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Transfer['status'] }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[status]}`}>
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}

function Section({
  title,
  empty,
  rows,
  render,
}: {
  title: string;
  empty: string;
  rows: Transfer[];
  render: (t: Transfer) => React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-edge bg-surface px-3 py-4 text-sm text-ink-muted">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-edge text-left text-sm text-ink-muted">
                <th className="px-3 py-2">Transfer</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Lines</th>
                <th className="px-3 py-2">Raised</th>
                <th className="px-3 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-edge last:border-0 hover:bg-bg">
                  <td className="px-3 py-2 font-mono text-sm">{t.transferNumber}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{t.fromBranchCode}</span>
                    <span className="mx-1 text-ink-muted">→</span>
                    <span className="font-mono text-xs">{t.toBranchCode}</span>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {t.items.length}
                    {t.status === 'RECEIVED' &&
                      t.items.some((i) => i.qtyReceived < i.qtyBase) && (
                        <span className="ml-2 text-xs font-semibold text-warn">short</span>
                      )}
                  </td>
                  <td className="px-3 py-2 text-sm text-ink-muted">{shortDate(t.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{render(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateTransferDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [toBranchId, setToBranchId] = useState('');
  const [lines, setLines] = useState<{ sourceBatchId: string; qtyBase: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: branches = [] } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api<Branch[]>('/branches'),
  });

  // Branch-scoped server-side, so this is only ever this shop's own stock.
  const { data: batches } = useQuery({
    queryKey: ['batches', 'transferable'],
    queryFn: () => api<{ data: BatchOpt[] }>('/batches?pageSize=200&status=ACTIVE'),
  });

  const available = (batches?.data ?? []).filter((b) => b.qtyOnHand > 0);
  const destinations = branches.filter((b) => b.id !== user?.activeBranch?.id);

  const save = useMutation({
    mutationFn: () =>
      api('/transfers', {
        method: 'POST',
        queue: { label: 'Stock transfer raised' },
        body: { toBranchId, items: lines.filter((l) => l.sourceBatchId && l.qtyBase > 0) },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not raise the transfer'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const usable = lines.filter((l) => l.sourceBatchId && l.qtyBase > 0);
    if (!toBranchId) return setError('Choose a destination branch.');
    if (usable.length === 0) return setError('Add at least one batch to send.');
    const ids = usable.map((l) => l.sourceBatchId);
    if (new Set(ids).size !== ids.length) return setError('The same batch appears more than once.');
    save.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-edge bg-surface p-6"
      >
        <h2 className="text-lg font-bold">New transfer</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Stock stays on your shelf until you dispatch it.
        </p>

        <label className="mb-1 mt-3 block text-sm font-medium" htmlFor="trf-dest">
          Send to *
        </label>
        <select id="trf-dest" value={toBranchId} onChange={(e) => setToBranchId(e.target.value)} className={input}>
          <option value="">Choose a branch…</option>
          {destinations.map((b) => (
            <option key={b.id} value={b.id}>
              {b.code} — {b.name}
            </option>
          ))}
        </select>

        <fieldset className="mt-4">
          <legend className="mb-1 text-sm font-medium">Batches to send *</legend>
          {lines.map((line, idx) => {
            const picked = available.find((b) => b.id === line.sourceBatchId);
            return (
              <div key={idx} className="mb-2 flex gap-2">
                <select
                  value={line.sourceBatchId}
                  onChange={(e) =>
                    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, sourceBatchId: e.target.value } : l)))
                  }
                  className={`${input} flex-1`}
                >
                  <option value="">Choose a batch…</option>
                  {available.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.productName} · {b.batchNumber} · exp {b.expiryDate} · {b.qtyOnHand} on hand
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  max={picked?.qtyOnHand}
                  value={line.qtyBase || ''}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, i) => (i === idx ? { ...l, qtyBase: Number(e.target.value) } : l)),
                    )
                  }
                  placeholder="Qty"
                  className={`${input} w-24`}
                />
                <button
                  type="button"
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                  className="rounded-lg border border-edge px-3 text-danger"
                  aria-label="Remove line"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, { sourceBatchId: '', qtyBase: 0 }])}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm"
          >
            + Add batch
          </button>
        </fieldset>

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">
            Cancel
          </button>
          <button
            disabled={save.isPending}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {save.isPending ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ReceiveTransferDialog({
  transfer,
  onClose,
  onDone,
}: {
  transfer: Transfer;
  onClose: () => void;
  onDone: () => void;
}) {
  // Default to "everything arrived" — the common case; short receipts are the
  // exception the operator edits down to.
  const [received, setReceived] = useState<Record<string, number>>(
    Object.fromEntries(transfer.items.map((i) => [i.id, i.qtyBase])),
  );
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/transfers/${transfer.id}/receive`, {
        method: 'POST',
        queue: { label: `Transfer received: ${transfer.transferNumber ?? transfer.id}` },
        body: {
          items: transfer.items.map((i) => ({ itemId: i.id, qtyReceived: received[i.id] ?? 0 })),
          notes: notes || undefined,
        },
      }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not record the receipt'),
  });

  const short = transfer.items.some((i) => (received[i.id] ?? 0) < i.qtyBase);
  const input = 'rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-edge bg-surface p-6"
      >
        <h2 className="text-lg font-bold">Receive {transfer.transferNumber}</h2>
        <p className="mt-1 text-xs text-ink-muted">
          From {transfer.fromBranchCode}. Count what actually arrived — a shortfall is reported back
          to the sending branch rather than written off.
        </p>

        <table className="mt-3 w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="py-2">Item</th>
              <th className="py-2">Sent</th>
              <th className="py-2">Received</th>
            </tr>
          </thead>
          <tbody>
            {transfer.items.map((i) => (
              <tr key={i.id} className="border-b border-edge last:border-0">
                <td className="py-2">
                  {i.productName}
                  <span className="block text-xs text-ink-muted">
                    {i.batchNumber} · exp {i.expiryDate}
                  </span>
                </td>
                <td className="py-2 text-ink-muted">
                  {i.qtyBase} {i.baseUnit}
                </td>
                <td className="py-2">
                  <input
                    type="number"
                    min={0}
                    max={i.qtyBase}
                    value={received[i.id] ?? 0}
                    onChange={(e) =>
                      setReceived((r) => ({ ...r, [i.id]: Math.min(Number(e.target.value), i.qtyBase) }))
                    }
                    className={`${input} w-24`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {short && (
          <p className="mt-3 rounded bg-warn/10 px-3 py-2 text-sm text-warn">
            Short receipt — {transfer.fromBranchCode} will be notified of the discrepancy.
          </p>
        )}

        <label className="mb-1 mt-3 block text-sm font-medium" htmlFor="trf-notes">
          Notes
        </label>
        <input
          id="trf-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything worth recording about the delivery"
          className={`${input} w-full`}
        />

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">
            Cancel
          </button>
          <button
            disabled={save.isPending}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900"
          >
            {save.isPending ? 'Saving…' : 'Confirm receipt'}
          </button>
        </div>
      </form>
    </div>
  );
}
