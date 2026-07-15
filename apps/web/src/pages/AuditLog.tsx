import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { shortDate, timeOf } from '../lib/format';

interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  createdAt: string;
}

const ENTITIES = ['', 'sale', 'product', 'user', 'stock_adjustment', 'purchase_order', 'goods_receipt', 'sale_return', 'setting', 'batch'];

/** Screen 15 — the attribution trail (BR-06). Admin/Manager. */
export default function AuditLog() {
  const [entity, setEntity] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['audit', entity],
    queryFn: () =>
      api<{ data: AuditRow[]; meta: { total: number } }>(
        `/audit-logs?pageSize=100${entity ? `&entity=${entity}` : ''}`,
      ),
  });

  const actionColor = (action: string) => {
    if (/void|lockout|reuse|delete|reject/.test(action)) return 'text-danger';
    if (/price_change|adjustment|return|reset/.test(action)) return 'text-warn';
    return 'text-primary';
  };

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold">Audit log</h1>
        <select
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          className="rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm"
        >
          {ENTITIES.map((e) => (
            <option key={e} value={e}>{e === '' ? 'All entities' : e.replace('_', ' ')}</option>
          ))}
        </select>
        <span className="ml-auto text-sm text-ink-muted">{data?.meta.total ?? 0} entries</span>
      </div>

      <div className="rounded-xl border border-edge bg-surface">
        {(data?.data ?? []).map((row) => (
          <div key={row.id} className="border-b border-edge last:border-0">
            <button
              onClick={() => setExpanded(expanded === row.id ? null : row.id)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-bg"
            >
              <span className={`font-mono text-sm font-semibold ${actionColor(row.action)}`}>{row.action}</span>
              <span className="text-sm text-ink-muted">
                {row.entity} · {row.entityId.slice(0, 8)}
              </span>
              <span className="ml-auto shrink-0 text-sm text-ink-muted">
                {shortDate(row.createdAt)} {timeOf(row.createdAt)}
              </span>
            </button>
            {expanded === row.id && (
              <div className="grid gap-3 border-t border-edge bg-bg px-4 py-3 sm:grid-cols-2">
                <Diff label="Before" value={row.before} tone="danger" />
                <Diff label="After" value={row.after} tone="ok" />
                <div className="text-xs text-ink-muted sm:col-span-2">
                  user: {row.userId ?? 'system'} {row.ipAddress ? `· ip: ${row.ipAddress}` : ''} · entity id: {row.entityId}
                </div>
              </div>
            )}
          </div>
        ))}
        {data && data.data.length === 0 && (
          <p className="p-6 text-center text-ink-muted">No audit entries yet.</p>
        )}
      </div>
    </div>
  );
}

function Diff({ label, value, tone }: { label: string; value: unknown; tone: 'danger' | 'ok' }) {
  return (
    <div>
      <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${tone === 'danger' ? 'text-danger' : 'text-ok'}`}>
        {label}
      </div>
      <pre className="overflow-x-auto rounded border border-edge bg-surface p-2 text-xs">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
