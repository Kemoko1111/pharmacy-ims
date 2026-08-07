import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface BranchRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  receiptHeader: { line1?: string; line2?: string; line3?: string } | null;
  isActive: boolean;
  documentCount: number;
  /** Code is embedded in issued document numbers once any exist. */
  codeLocked: boolean;
}

/**
 * Branches (Admin) — ADR-010.
 *
 * The system ships with one anonymous placeholder branch rather than invented
 * shops, because we do not know where the client's branches actually are. This
 * is where the real ones get created, and where the placeholder gets renamed
 * once a site visit confirms it.
 */
export default function Branches() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<BranchRow | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const { data: branches = [], isLoading } = useQuery({
    queryKey: ['branches', 'admin', showInactive],
    queryFn: () => api<BranchRow[]>(`/branches?includeInactive=${showInactive}`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['branches'] });
    queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const toggleActive = useMutation({
    mutationFn: (b: BranchRow) =>
      api(`/branches/${b.id}`, {
        method: 'PATCH',
        body: { isActive: !b.isActive },
        queue: { label: `Branch ${b.isActive ? 'closed' : 'reopened'}: ${b.code}` },
      }),
    onSuccess: invalidate,
  });

  const activeCount = branches.filter((b) => b.isActive).length;

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Branches</h1>
        <button
          onClick={() => setEditing('new')}
          className="ml-auto rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + New branch
        </button>
      </div>

      <p className="mb-4 text-sm text-ink-muted">
        Each shop keeps its own stock, sales and purchase orders. Products, prices,
        suppliers and customers are shared across all of them.
      </p>

      {activeCount === 1 && branches[0]?.code === 'MAIN' && (
        <p className="mb-4 rounded-lg border border-edge bg-warn/10 px-3 py-2 text-sm">
          <strong>Main Branch</strong> is a placeholder created at install. Rename it to the
          real shop, or add your branches below — you can still change its code because it
          has not issued any receipts yet.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Address</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Documents</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && branches.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-muted">
                  No branches yet — create the first one.
                </td>
              </tr>
            )}
            {branches.map((b) => (
              <tr
                key={b.id}
                className={`border-b border-edge last:border-0 hover:bg-bg ${b.isActive ? '' : 'opacity-50'}`}
              >
                <td className="px-3 py-2">
                  <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                    {b.code}
                  </span>
                  {b.id === user?.activeBranch?.id && (
                    <span className="ml-2 text-xs text-ink-muted">you are here</span>
                  )}
                </td>
                <td className="px-3 py-2 font-medium">{b.name}</td>
                <td className="px-3 py-2 text-sm text-ink-muted">{b.address ?? '—'}</td>
                <td className="px-3 py-2 text-sm text-ink-muted">{b.phone ?? '—'}</td>
                <td className="px-3 py-2 text-sm text-ink-muted">
                  {b.documentCount === 0 ? (
                    <span title="Code can still be changed">none yet</span>
                  ) : (
                    <span title="Receipts, orders and transfers carry this branch code">
                      {b.documentCount} · code locked
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-sm font-semibold ${b.isActive ? 'text-ok' : 'text-danger'}`}>
                    {b.isActive ? 'active' : 'closed'}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button onClick={() => setEditing(b)} className="text-primary hover:underline">
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive.mutate(b)}
                    disabled={toggleActive.isPending || (b.isActive && activeCount === 1)}
                    title={
                      b.isActive && activeCount === 1
                        ? 'Cannot close the only active branch'
                        : undefined
                    }
                    className={`ml-3 hover:underline disabled:cursor-not-allowed disabled:opacity-40 ${
                      b.isActive ? 'text-danger' : 'text-ok'
                    }`}
                  >
                    {b.isActive ? 'Close' : 'Reopen'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
          className="h-4 w-4"
        />
        Show closed branches
      </label>

      {editing && (
        <BranchForm
          branch={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function BranchForm({
  branch,
  onClose,
  onDone,
}: {
  branch: BranchRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    code: branch?.code ?? '',
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    phone: branch?.phone ?? '',
    line1: branch?.receiptHeader?.line1 ?? '',
    line2: branch?.receiptHeader?.line2 ?? '',
    line3: branch?.receiptHeader?.line3 ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const codeLocked = branch?.codeLocked ?? false;

  const save = useMutation({
    mutationFn: () => {
      const receiptHeader =
        form.line1 || form.line2 || form.line3
          ? {
              ...(form.line1 ? { line1: form.line1 } : {}),
              ...(form.line2 ? { line2: form.line2 } : {}),
              ...(form.line3 ? { line3: form.line3 } : {}),
            }
          : undefined;
      const body = {
        name: form.name,
        address: form.address || undefined,
        phone: form.phone || undefined,
        ...(receiptHeader ? { receiptHeader } : {}),
        // Only sent when it can actually change, so an unchanged locked code
        // never trips BRANCH_CODE_IMMUTABLE on an unrelated edit.
        ...(!codeLocked ? { code: form.code.toUpperCase() } : {}),
      };
      return branch
        ? api(`/branches/${branch.id}`, {
            method: 'PATCH',
            body,
            queue: { label: `Branch edited: ${branch.code}` },
          })
        : api('/branches', { method: 'POST', body, queue: { label: 'Branch created' } });
    },
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!codeLocked && !/^[A-Za-z]{2,6}$/.test(form.code)) {
      setError('Code must be 2–6 letters, e.g. KUM.');
      return;
    }
    save.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';
  const label = 'mb-1 mt-3 block text-sm font-medium';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-edge bg-surface p-6"
      >
        <h2 className="text-lg font-bold">{branch ? `Edit ${branch.code}` : 'New branch'}</h2>

        <label className={label} htmlFor="br-code">
          Code *
        </label>
        <input
          id="br-code"
          value={form.code}
          disabled={codeLocked}
          maxLength={6}
          onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
          placeholder="KUM"
          className={`${input} font-mono uppercase disabled:cursor-not-allowed disabled:opacity-60`}
        />
        <p className="mt-1 text-xs text-ink-muted">
          {codeLocked
            ? `Locked — ${branch?.documentCount} receipt/order number(s) already start with ${branch?.code}.`
            : '2–6 letters. Prefixes this branch’s receipt, order and transfer numbers, e.g. KUM-RCP-2026-000123. Fixed once the branch issues its first document.'}
        </p>

        <label className={label} htmlFor="br-name">
          Name *
        </label>
        <input
          id="br-name"
          required
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Kumasi Branch"
          className={input}
        />

        <label className={label} htmlFor="br-address">
          Address
        </label>
        <input
          id="br-address"
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          className={input}
        />

        <label className={label} htmlFor="br-phone">
          Phone
        </label>
        <input
          id="br-phone"
          value={form.phone}
          onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          className={input}
        />

        <fieldset className="mt-4 rounded-lg border border-edge p-3">
          <legend className="px-1 text-sm font-medium">Receipt header</legend>
          <p className="mb-2 text-xs text-ink-muted">
            Printed at the top of this branch&rsquo;s receipts. Leave blank to use the
            shared header from Settings.
          </p>
          {(['line1', 'line2', 'line3'] as const).map((k, i) => (
            <input
              key={k}
              value={form[k]}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              placeholder={['Pharmacy name', 'Address', 'Tel: …'][i]}
              className={`${input} mb-2 last:mb-0`}
            />
          ))}
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
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
