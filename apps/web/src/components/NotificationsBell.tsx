import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ghs, shortDate } from '../lib/format';

interface Notification {
  id: string;
  type: 'LOW_STOCK' | 'EXPIRY_90' | 'EXPIRED' | 'NEG_STOCK_EXCEPTION';
  payload: Record<string, unknown>;
  createdAt: string;
}

function describe(n: Notification): string {
  const p = n.payload;
  switch (n.type) {
    case 'LOW_STOCK':
      return `${p.productName}: ${p.qtyBase} left (reorder at ${p.reorderLevel})`;
    case 'EXPIRED':
      return `${p.productName} batch ${p.batchNumber} EXPIRED — ${p.qtyOnHand} units, ${ghs(String(p.valueAtCost))}`;
    case 'EXPIRY_90':
      return `${p.productName} batch ${p.batchNumber} expires ${p.expiryDate} — ${ghs(String(p.valueAtRisk))} at risk`;
    case 'NEG_STOCK_EXCEPTION':
      return `Offline oversell: ${p.productName} short by ${p.qtyShort} — reconcile stock`;
    default:
      return JSON.stringify(p);
  }
}

const TYPE_CLS: Record<string, string> = {
  LOW_STOCK: 'text-warn',
  EXPIRY_90: 'text-warn',
  EXPIRED: 'text-danger',
  NEG_STOCK_EXCEPTION: 'text-danger',
};

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ data: Notification[]; meta: { total: number } }>('/notifications?unseen=true&pageSize=20'),
    refetchInterval: 60_000,
  });

  const markSeen = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/seen`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const count = data?.meta.total ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded px-2 py-1 text-lg"
        title="Notifications"
      >
        🔔
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-xs font-bold text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-96 rounded-xl border border-edge bg-surface shadow-lg">
          <div className="border-b border-edge px-4 py-2 font-semibold">Needs attention</div>
          <div className="max-h-96 overflow-auto">
            {(data?.data ?? []).map((n) => (
              <div key={n.id} className="flex items-start gap-2 border-b border-edge px-4 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${TYPE_CLS[n.type] ?? ''}`}>{describe(n)}</div>
                  <div className="text-xs text-ink-muted">{shortDate(n.createdAt)}</div>
                </div>
                <button
                  onClick={() => markSeen.mutate(n.id)}
                  className="shrink-0 text-xs text-ink-muted hover:text-ink"
                  title="Mark seen"
                >
                  ✓ seen
                </button>
              </div>
            ))}
            {count === 0 && <p className="px-4 py-6 text-center text-sm text-ink-muted">All clear.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
