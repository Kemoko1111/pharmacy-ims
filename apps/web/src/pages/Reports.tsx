import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, BASE, fetchWithTimeout, NetworkError } from '../lib/api';
import { ghs } from '../lib/format';

type Tab = 'sales' | 'stock-valuation' | 'expiring' | 'shrinkage';

const TABS: { id: Tab; label: string }[] = [
  { id: 'sales', label: 'Sales' },
  { id: 'stock-valuation', label: 'Stock valuation' },
  { id: 'expiring', label: 'Expiring' },
  { id: 'shrinkage', label: 'Shrinkage' },
];

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Bulk export over a shop link, not a POS round trip — the POS budget is far too tight. */
const EXPORT_TIMEOUT_MS = 60_000;

/** Screen 9 — Manager reports with CSV export (US-13). */
export default function Reports() {
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const [groupBy, setGroupBy] = useState<'product' | 'category' | 'day'>('product');
  const [windowDays, setWindowDays] = useState(90);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const params =
    tab === 'sales'
      ? `?from=${from}&to=${to}&groupBy=${groupBy}`
      : tab === 'shrinkage'
        ? `?from=${from}&to=${to}`
        : tab === 'expiring'
          ? `?window=${windowDays}`
          : '';

  const { data, isLoading } = useQuery({
    queryKey: ['report', tab, params],
    queryFn: () => api<Record<string, unknown>>(`/reports/${tab}${params}`),
  });

  /**
   * Streams a file rather than JSON, so it goes around `api()` — but it still
   * needs the deadline `api()` provides, or a hung link leaves the button dead
   * with no explanation. A month of sales is a bigger response than a POS call,
   * hence the longer budget.
   */
  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetchWithTimeout(
        `${BASE}/reports/${tab}/export${params ? params + '&' : '?'}format=csv`,
        { headers: { Authorization: `Bearer ${localStorage.getItem('pt-access')}` } },
        EXPORT_TIMEOUT_MS,
      );
      if (!res.ok) {
        setExportError(res.status === 401 ? 'Session expired — sign in again.' : `Export failed (${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? `${tab}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(
        err instanceof NetworkError
          ? 'No answer from the server — check the connection and try again.'
          : 'Export failed.',
      );
    } finally {
      setExporting(false);
    }
  };

  const dateInput = 'rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm';

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Reports</h1>
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3 py-1 text-sm ${
                tab === t.id ? 'bg-primary/15 font-semibold text-primary' : 'border border-edge text-ink-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={exportCsv}
          disabled={exporting}
          className="ml-auto rounded-lg border border-primary px-4 py-1.5 text-sm font-semibold text-primary disabled:opacity-50"
        >
          {exporting ? 'Exporting…' : '⬇ Export CSV'}
        </button>
      </div>

      {exportError && (
        <p role="alert" className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {exportError}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {(tab === 'sales' || tab === 'shrinkage') && (
          <>
            <label>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={dateInput} />
            <label>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={dateInput} />
          </>
        )}
        {tab === 'sales' && (
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} className={dateInput}>
            <option value="product">by product</option>
            <option value="category">by category</option>
            <option value="day">by day</option>
          </select>
        )}
        {tab === 'expiring' && (
          <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} className={dateInput}>
            <option value={30}>≤ 30 days</option>
            <option value={60}>≤ 60 days</option>
            <option value={90}>≤ 90 days</option>
          </select>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        {isLoading && <p className="p-6 text-center text-ink-muted">Loading…</p>}
        {!isLoading && data && <ReportTable tab={tab} data={data} />}
      </div>
    </div>
  );
}

function ReportTable({ tab, data }: { tab: Tab; data: Record<string, unknown> }) {
  const rows = (data.rows ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return <p className="p-6 text-center text-ink-muted">Nothing in this range.</p>;

  const th = 'px-3 py-2 text-left text-sm text-ink-muted';
  const td = 'px-3 py-2';

  if (tab === 'sales') {
    return (
      <table className="w-full text-[15px]">
        <thead><tr className="border-b border-edge"><th className={th}>Group</th><th className={`${th} text-right`}>Units</th><th className={`${th} text-right`}>Receipts</th><th className={`${th} text-right`}>Gross</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-edge last:border-0">
              <td className={td}>{String(r.name)}</td>
              <td className={`${td} text-right`}>{String(r.qtyBase)}</td>
              <td className={`${td} text-right`}>{String(r.receipts)}</td>
              <td className={`${td} text-right font-semibold`}>{ghs(String(r.gross))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (tab === 'stock-valuation') {
    return (
      <>
        <table className="w-full text-[15px]">
          <thead><tr className="border-b border-edge"><th className={th}>Product</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Reorder</th><th className={`${th} text-right`}>Value at cost</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-edge last:border-0">
                <td className={td}>{String(r.name)}</td>
                <td className={`${td} text-right`}>{String(r.qtyBase)} {String(r.baseUnit)}</td>
                <td className={`${td} text-right text-ink-muted`}>{String(r.reorderLevel)}</td>
                <td className={`${td} text-right font-semibold`}>{ghs(String(r.valueAtCost))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-edge px-3 py-2 text-right font-bold">Total {ghs(String(data.totalValue))}</p>
      </>
    );
  }
  if (tab === 'expiring') {
    return (
      <>
        <table className="w-full text-[15px]">
          <thead><tr className="border-b border-edge"><th className={th}>Product</th><th className={th}>Batch</th><th className={th}>Expiry</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Value at risk</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-edge last:border-0">
                <td className={td}>{String(r.productName)}</td>
                <td className={`${td} font-mono text-sm`}>{String(r.batchNumber)}</td>
                <td className={td}>{String(r.expiryDate)} <span className="text-sm text-ink-muted">({String(r.daysToExpiry)} d)</span></td>
                <td className={`${td} text-right`}>{String(r.qtyOnHand)}</td>
                <td className={`${td} text-right font-semibold text-warn`}>{ghs(String(r.valueAtRisk))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-edge px-3 py-2 text-right font-bold text-warn">At risk {ghs(String(data.valueAtRisk))}</p>
      </>
    );
  }
  return (
    <table className="w-full text-[15px]">
      <thead><tr className="border-b border-edge"><th className={th}>Reason</th><th className={`${th} text-right`}>Adjustments</th><th className={`${th} text-right`}>Units lost</th><th className={`${th} text-right`}>Value</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-edge last:border-0">
            <td className={td}>{String(r.reason).replace('_', ' ')}</td>
            <td className={`${td} text-right`}>{String(r.adjustments)}</td>
            <td className={`${td} text-right`}>{String(r.qtyBase)}</td>
            <td className={`${td} text-right font-semibold text-danger`}>{ghs(String(r.value))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
