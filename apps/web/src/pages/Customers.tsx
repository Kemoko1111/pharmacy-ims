import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { ghs, shortDate } from '../lib/format';

interface Customer {
  id: string;
  fullName: string;
  phone: string | null;
  notes: string | null;
  createdAt: string;
}

interface HistoryRow {
  id: string;
  receiptNumber: string;
  soldAt: string;
  total: string;
  items: string;
}

/** US-15 — Pharmacist/Manager only; purchase history is health-adjacent. */
export default function Customers() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);

  const { data } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => api<{ data: Customer[] }>(`/customers?pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold">Customers</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name or phone…"
          className="flex-1 rounded-lg border border-edge bg-surface px-3 py-2 outline-none focus:border-primary"
        />
        <button
          onClick={() => setEditing('new')}
          className="rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + New customer
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2">Since</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((c) => (
              <tr key={c.id} className="border-b border-edge last:border-0 hover:bg-bg">
                <td className="px-3 py-2 font-medium">{c.fullName}</td>
                <td className="px-3 py-2 text-ink-muted">{c.phone ?? '—'}</td>
                <td className="max-w-56 truncate px-3 py-2 text-sm text-ink-muted">{c.notes ?? ''}</td>
                <td className="px-3 py-2 text-sm text-ink-muted">{shortDate(c.createdAt)}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setViewing(c)} className="text-primary hover:underline">History</button>
                  <button onClick={() => setEditing(c)} className="ml-3 text-primary hover:underline">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && <p className="p-6 text-center text-ink-muted">No customers found.</p>}
      </div>

      {editing && (
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['customers'] });
          }}
        />
      )}
      {viewing && <HistoryDialog customer={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function CustomerForm({ customer, onClose, onDone }: { customer: Customer | null; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    fullName: customer?.fullName ?? '',
    phone: customer?.phone ?? '',
    notes: customer?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      customer
        ? api(`/customers/${customer.id}`, { method: 'PATCH', body: form })
        : api('/customers', { method: 'POST', body: form }),
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';
  const label = 'mb-1 mt-3 block text-sm font-medium';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">{customer ? `Edit — ${customer.fullName}` : 'New customer'}</h2>

        <label className={label}>Full name *</label>
        <input required value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} className={input} />

        <label className={label}>Phone</label>
        <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={input} />

        <label className={label}>Notes (clinical — pharmacist eyes only)</label>
        <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={3} className={input} />

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button disabled={save.isPending} className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function HistoryDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['customer-history', customer.id],
    queryFn: () => api<{ data: HistoryRow[]; meta: { total: number } }>(`/customers/${customer.id}/history`),
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-edge bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">{customer.fullName} — purchase history</h2>
        <div className="mt-3 max-h-96 overflow-auto">
          {(data?.data ?? []).map((s) => (
            <div key={s.id} className="border-b border-edge py-2 last:border-0">
              <div className="flex justify-between">
                <span className="font-mono text-sm">{s.receiptNumber}</span>
                <span className="font-semibold">{ghs(s.total)}</span>
              </div>
              <div className="text-sm text-ink-muted">
                {shortDate(s.soldAt)} · {s.items}
              </div>
            </div>
          ))}
          {data && data.data.length === 0 && (
            <p className="py-6 text-center text-ink-muted">No purchases on record.</p>
          )}
        </div>
        <button onClick={onClose} className="mt-4 w-full rounded-lg border border-edge py-2">Close</button>
      </div>
    </div>
  );
}
