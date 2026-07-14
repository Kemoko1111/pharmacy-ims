import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ghs, shortDate } from '../lib/format';

interface BatchRow {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  batchNumber: string;
  expiryDate: string;
  daysToExpiry: number;
  qtyOnHand: number;
  unitCost: string;
  valueAtCost: string;
  status: 'ACTIVE' | 'EXPIRED' | 'QUARANTINED' | 'DEPLETED';
}

const WINDOWS = [
  { label: 'All', value: '' },
  { label: '≤ 90 days', value: '90' },
  { label: '≤ 60 days', value: '60' },
  { label: '≤ 30 days', value: '30' },
];

/** Screen 6 — pharmacist's compliance view. */
export default function Batches() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [windowDays, setWindowDays] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['batches', windowDays],
    queryFn: () =>
      api<{ data: BatchRow[]; meta: { total: number } }>(
        `/batches?pageSize=200${windowDays ? `&expiringWithinDays=${windowDays}` : ''}`,
      ),
  });

  const canQuarantine = ['PHARMACIST', 'MANAGER', 'ADMIN'].includes(user?.role ?? '');
  const expiredWithStock = (data?.data ?? []).filter(
    (b) => b.qtyOnHand > 0 && (b.status === 'EXPIRED' || b.daysToExpiry < 0) && b.status !== 'QUARANTINED',
  );

  const quarantine = useMutation({
    mutationFn: () => api<{ quarantined: number }>('/adjustments/quarantine-expired', { method: 'POST' }),
    onSuccess: (res) => {
      setMessage(
        `${res.quarantined} batch(es) quarantined — disposal adjustments await Manager approval.`,
      );
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['adjustments'] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Quarantine failed'),
  });

  const chip = (b: BatchRow) => {
    if (b.status === 'QUARANTINED') return <Chip cls="bg-ink-muted/20 text-ink-muted">QUARANTINED</Chip>;
    if (b.status === 'DEPLETED') return <Chip cls="bg-ink-muted/10 text-ink-muted">DEPLETED</Chip>;
    if (b.status === 'EXPIRED' || b.daysToExpiry < 0) return <Chip cls="bg-danger/15 text-danger">EXPIRED</Chip>;
    if (b.daysToExpiry <= 30) return <Chip cls="bg-danger/15 text-danger">≤ 30 d</Chip>;
    if (b.daysToExpiry <= 90) return <Chip cls="bg-warn/15 text-warn">≤ 90 d</Chip>;
    return <Chip cls="bg-ok/15 text-ok">OK</Chip>;
  };

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Batches & expiry</h1>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              onClick={() => setWindowDays(w.value)}
              className={`rounded-full px-3 py-1 text-sm ${
                windowDays === w.value ? 'bg-primary/15 font-semibold text-primary' : 'border border-edge text-ink-muted'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        {canQuarantine && expiredWithStock.length > 0 && (
          <button
            onClick={() => quarantine.mutate()}
            disabled={quarantine.isPending}
            className="ml-auto rounded-lg bg-danger px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            Quarantine {expiredWithStock.length} expired
          </button>
        )}
      </div>

      {message && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-primary/10 px-4 py-2">
          <span>{message}</span>
          <button onClick={() => setMessage(null)} className="font-bold">✕</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Batch no.</th>
              <th className="px-3 py-2">Expiry</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Value at cost</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((b) => (
              <tr key={b.id} className="border-b border-edge last:border-0 hover:bg-bg">
                <td className="px-3 py-2 font-medium">{b.productName}</td>
                <td className="px-3 py-2 font-mono text-sm">{b.batchNumber}</td>
                <td className="px-3 py-2">
                  {shortDate(b.expiryDate)}
                  <span className="ml-1 text-sm text-ink-muted">
                    ({b.daysToExpiry >= 0 ? `${b.daysToExpiry} d` : `${-b.daysToExpiry} d ago`})
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  {b.qtyOnHand} {b.baseUnit}
                </td>
                <td className="px-3 py-2 text-right">{ghs(b.valueAtCost)}</td>
                <td className="px-3 py-2">{chip(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.data.length === 0 && <p className="p-6 text-center text-ink-muted">No batches in this window.</p>}
      </div>
    </div>
  );
}

function Chip({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}
