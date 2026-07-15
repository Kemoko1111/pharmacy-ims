import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate } from '../lib/format';

interface ProductRow {
  id: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  categoryName?: string;
  baseUnit: string;
  sellingPriceBase: string;
  reorderLevel: number;
  qtyOnHand: number;
  nearestExpiry: string | null;
  prescriptionOnly: boolean;
  units: { id: string; unitName: string; factorToBase: number; sellingPrice: string }[];
  barcodes: { barcode: string }[];
}

interface Category {
  id: string;
  name: string;
}

const CAN_EDIT = ['INVENTORY_OFFICER', 'MANAGER', 'ADMIN'];

// day-resolution "now" for expiry chips; module scope keeps render pure
const NOW = Date.now();

export default function Products() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const lowStock = params.get('lowStock') === 'true';

  const { data } = useQuery({
    queryKey: ['products', q, lowStock],
    queryFn: () =>
      api<{ data: ProductRow[]; meta: { total: number } }>(
        `/products?pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}${lowStock ? '&lowStock=true' : ''}`,
      ),
  });

  const canEdit = CAN_EDIT.includes(user?.role ?? '');

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Products {lowStock && <span className="text-warn">(low stock)</span>}</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name / generic / barcode…"
          className="min-w-64 flex-1 rounded-lg border border-edge bg-surface px-3 py-2 outline-none focus:border-primary"
        />
        {canEdit && (
          <button
            onClick={() => setEditing('new')}
            className="rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
          >
            + New product
          </button>
        )}
        {user?.role === 'ADMIN' && <QbImportButton />}
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Price (base)</th>
              <th className="px-3 py-2 text-right">Stock</th>
              <th className="px-3 py-2">Nearest expiry</th>
              {canEdit && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((p) => {
              const low = p.qtyOnHand <= p.reorderLevel;
              const daysToExpiry = p.nearestExpiry
                ? Math.ceil((new Date(p.nearestExpiry).getTime() - NOW) / 86_400_000)
                : null;
              return (
                <tr key={p.id} className="border-b border-edge last:border-0 hover:bg-bg">
                  <td className="px-3 py-2">
                    <span className="font-medium">{p.name}</span>
                    {p.prescriptionOnly && (
                      <span className="ml-2 rounded bg-danger/10 px-1.5 text-xs font-semibold text-danger">Rx</span>
                    )}
                    <div className="text-sm text-ink-muted">
                      {[p.genericName, p.strength].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-ink-muted">{p.categoryName}</td>
                  <td className="px-3 py-2 text-right">{ghs(p.sellingPriceBase)}</td>
                  <td className={`px-3 py-2 text-right font-medium ${low ? 'text-warn' : ''}`}>
                    {p.qtyOnHand} {p.baseUnit}
                    {low && ' ⚠'}
                  </td>
                  <td className="px-3 py-2">
                    {p.nearestExpiry ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-sm ${
                          daysToExpiry! < 0
                            ? 'bg-danger/15 text-danger'
                            : daysToExpiry! <= 90
                              ? 'bg-warn/15 text-warn'
                              : 'text-ink-muted'
                        }`}
                      >
                        {shortDate(p.nearestExpiry)}
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => setEditing(p)} className="text-primary hover:underline">
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && data.data.length === 0 && <p className="p-6 text-center text-ink-muted">No products found.</p>}
      </div>

      {editing && <ProductForm product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function UnitRow({
  productId,
  unit,
}: {
  productId: string;
  unit: { id: string; unitName: string; factorToBase: number; sellingPrice: string; isActive?: boolean };
}) {
  const queryClient = useQueryClient();
  const retire = useMutation({
    mutationFn: () => api(`/products/${productId}/units/${unit.id}/retire`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });
  const retired = unit.isActive === false || retire.isSuccess;

  return (
    <div className={`flex items-center justify-between py-1.5 text-sm ${retired ? 'opacity-50' : ''}`}>
      <span>
        {unit.unitName} = {unit.factorToBase} base @ {ghs(unit.sellingPrice)}
        {retired && <span className="ml-2 rounded bg-ink-muted/15 px-1.5 text-xs">RETIRED</span>}
      </span>
      {!retired && (
        <button
          type="button"
          onClick={() => confirm(`Retire "${unit.unitName}"? It disappears from the POS but stays on old receipts.`) && retire.mutate()}
          disabled={retire.isPending}
          className="text-warn hover:underline disabled:opacity-50"
        >
          Retire
        </button>
      )}
    </div>
  );
}

/** US-16: QuickBooks item-list CSV upload with per-row error report. */
function QbImportButton() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File, importStock: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'}/products/import?importStock=${importStock}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('pt-access')}` },
          body: form,
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Import failed');
      setResult(json);
      queryClient.invalidateQueries({ queryKey: ['products'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="cursor-pointer rounded-lg border border-primary px-4 py-2 font-semibold text-primary">
        {busy ? 'Importing…' : 'Import QB CSV'}
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const withStock = confirm(
              'Also import on-hand quantities as placeholder batches?\n\n' +
                'OK = yes (batches flagged QB-IMPORT for pharmacist review)\nCancel = catalog only',
            );
            void upload(file, withStock);
          }}
        />
      </label>

      {(result || error) && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={() => { setResult(null); setError(null); }}>
          <div className="w-full max-w-md rounded-xl border border-edge bg-surface p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">QuickBooks import</h2>
            {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-danger">{error}</p>}
            {result && (
              <>
                <p className="mt-2">
                  <b className="text-ok">{result.imported} imported</b> · {result.skipped} skipped (already exist)
                  {result.errors.length > 0 && <> · <b className="text-warn">{result.errors.length} rows with problems</b></>}
                </p>
                {result.errors.length > 0 && (
                  <div className="mt-2 max-h-48 overflow-auto rounded border border-edge p-2 text-sm">
                    {result.errors.map((e, i) => (
                      <div key={i} className="text-ink-muted">
                        Row {e.row}: {e.message}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <button
              onClick={() => { setResult(null); setError(null); }}
              className="mt-4 w-full rounded-lg bg-primary py-2 font-semibold text-white dark:text-slate-900"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ProductForm({ product, onClose }: { product: ProductRow | null; onClose: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isManager = user?.role === 'MANAGER' || user?.role === 'ADMIN';
  const [error, setError] = useState<string | null>(null);

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<Category[]>('/categories'),
  });

  const [form, setForm] = useState({
    name: product?.name ?? '',
    genericName: product?.genericName ?? '',
    strength: product?.strength ?? '',
    form: 'TABLET',
    categoryId: '',
    baseUnit: product?.baseUnit ?? 'tablet',
    sellingPriceBase: product?.sellingPriceBase ?? '',
    reorderLevel: product?.reorderLevel ?? 0,
    prescriptionOnly: product?.prescriptionOnly ?? false,
    vatApplies: false,
    barcode: '',
    unitName: '',
    unitFactor: '',
    unitPrice: '',
  });

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      if (product) {
        const body: Record<string, unknown> = {
          name: form.name,
          genericName: form.genericName || undefined,
          strength: form.strength || undefined,
          reorderLevel: Number(form.reorderLevel),
          prescriptionOnly: form.prescriptionOnly,
        };
        if (isManager && form.sellingPriceBase !== product.sellingPriceBase) {
          body.sellingPriceBase = String(form.sellingPriceBase);
        }
        return api(`/products/${product.id}`, { method: 'PATCH', body });
      }
      return api('/products', {
        method: 'POST',
        body: {
          name: form.name,
          genericName: form.genericName || undefined,
          strength: form.strength || undefined,
          form: form.form,
          categoryId: form.categoryId,
          baseUnit: form.baseUnit,
          sellingPriceBase: String(form.sellingPriceBase),
          reorderLevel: Number(form.reorderLevel),
          vatApplies: form.vatApplies,
          prescriptionOnly: form.prescriptionOnly,
          ...(form.unitName && form.unitFactor && form.unitPrice
            ? { units: [{ unitName: form.unitName, factorToBase: Number(form.unitFactor), sellingPrice: String(form.unitPrice) }] }
            : {}),
          ...(form.barcode ? { barcodes: [form.barcode] } : {}),
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
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
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-edge bg-surface p-6"
      >
        <h2 className="text-lg font-bold">{product ? `Edit — ${product.name}` : 'New product'}</h2>

        <label className={label}>Name *</label>
        <input required value={form.name} onChange={(e) => set('name', e.target.value)} className={input} />

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Generic name</label>
            <input value={form.genericName} onChange={(e) => set('genericName', e.target.value)} className={input} />
          </div>
          <div>
            <label className={label}>Strength</label>
            <input value={form.strength} onChange={(e) => set('strength', e.target.value)} placeholder="500 mg" className={input} />
          </div>
        </div>

        {!product && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Category *</label>
              <select required value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} className={input}>
                <option value="">Select…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Base unit *</label>
              <input required value={form.baseUnit} onChange={(e) => set('baseUnit', e.target.value)} placeholder="tablet" className={input} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>
              Price / base unit (GHS) * {product && !isManager && <span className="text-warn">(Manager only)</span>}
            </label>
            <input
              required
              type="number"
              step="0.01"
              min="0"
              disabled={!!product && !isManager}
              value={form.sellingPriceBase}
              onChange={(e) => set('sellingPriceBase', e.target.value)}
              className={`${input} disabled:opacity-50`}
            />
          </div>
          <div>
            <label className={label}>Reorder level *</label>
            <input required type="number" min="0" value={form.reorderLevel} onChange={(e) => set('reorderLevel', e.target.value)} className={input} />
          </div>
        </div>

        {product && isManager && product.units.length > 0 && (
          <div className="mt-4 rounded-lg border border-edge p-3">
            <div className="text-sm font-semibold text-ink-muted">Pack units (retired, never edited — US-04)</div>
            {product.units.map((u) => (
              <UnitRow key={u.id} productId={product.id} unit={u} />
            ))}
          </div>
        )}

        <div className="mt-3 flex gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.prescriptionOnly} onChange={(e) => set('prescriptionOnly', e.target.checked)} />
            Prescription only
          </label>
          {!product && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.vatApplies} onChange={(e) => set('vatApplies', e.target.checked)} />
              VAT applies
            </label>
          )}
        </div>

        {!product && (
          <>
            <div className="mt-4 rounded-lg border border-edge p-3">
              <div className="text-sm font-semibold text-ink-muted">Optional: pack unit (US-04)</div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={label}>Unit name</label>
                  <input value={form.unitName} onChange={(e) => set('unitName', e.target.value)} placeholder="strip" className={input} />
                </div>
                <div>
                  <label className={label}>× base</label>
                  <input type="number" min="1" value={form.unitFactor} onChange={(e) => set('unitFactor', e.target.value)} placeholder="10" className={input} />
                </div>
                <div>
                  <label className={label}>Price (GHS)</label>
                  <input type="number" step="0.01" min="0" value={form.unitPrice} onChange={(e) => set('unitPrice', e.target.value)} className={input} />
                </div>
              </div>
            </div>
            <label className={label}>Barcode</label>
            <input value={form.barcode} onChange={(e) => set('barcode', e.target.value)} className={input} />
          </>
        )}

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
