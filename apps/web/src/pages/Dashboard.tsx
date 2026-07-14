import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { ghs } from '../lib/format';

interface DashboardData {
  today: {
    gross: string;
    receipts: number;
    byMethod: { method: string; amount: string }[];
  };
  actionNeeded: {
    lowStockCount: number;
    expiringCount: number;
    expiringValue: string;
    expiredCount: number;
  };
  trend14d: { day: string; gross: string; receipts: number }[];
  topSellers: { name: string; qtyBase: number }[];
}

/** Owner's morning view (★ Screen 4) — works on a phone over 3G. */
export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/reports/dashboard'),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return <div className="grid h-full place-items-center text-ink-muted">Loading dashboard…</div>;
  }

  const methods = Object.fromEntries(data.today.byMethod.map((m) => [m.method, m.amount]));
  const { actionNeeded: act } = data;
  const anyAction = act.lowStockCount + act.expiringCount + act.expiredCount > 0;

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Today</h1>
        <span className="text-ink-muted">
          {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
        </span>
      </div>

      {/* Cards — 44px+ targets, phone-first grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="SALES" value={ghs(data.today.gross)} />
        <StatCard label="RECEIPTS" value={String(data.today.receipts)} />
        <StatCard
          label="CASH / MOMO"
          value={`${Number(methods.CASH ?? 0).toFixed(0)} / ${Number(methods.MOMO ?? 0).toFixed(0)}`}
        />
      </div>

      {/* Action needed */}
      <h2 className="mb-2 mt-6 font-semibold text-warn">⚠ Action needed</h2>
      <div className="rounded-xl border border-edge bg-surface">
        {!anyAction && <p className="px-4 py-3 text-ink-muted">All clear — nothing needs attention.</p>}
        {act.lowStockCount > 0 && (
          <Link to="/products?lowStock=true" className="flex items-center justify-between border-b border-edge px-4 py-3 last:border-0 hover:bg-bg">
            <span>• {act.lowStockCount} products at/below reorder level</span>
            <span className="text-primary">→</span>
          </Link>
        )}
        {act.expiringCount > 0 && (
          <div className="flex items-center justify-between border-b border-edge px-4 py-3 last:border-0">
            <span>
              • {act.expiringCount} batches expire ≤ 90 days ({ghs(act.expiringValue)} at risk)
            </span>
          </div>
        )}
        {act.expiredCount > 0 && (
          <div className="px-4 py-3 font-semibold text-danger">
            • {act.expiredCount} batch{act.expiredCount > 1 ? 'es' : ''} EXPIRED — quarantine now
          </div>
        )}
      </div>

      {/* 14-day trend — inline SVG, no chart lib on the 3G path */}
      <h2 className="mb-2 mt-6 font-semibold">📈 Sales, last 14 days</h2>
      <div className="rounded-xl border border-edge bg-surface p-4">
        <Sparkline days={data.trend14d} />
      </div>

      <h2 className="mb-2 mt-6 font-semibold">🏆 Top sellers this week</h2>
      <div className="rounded-xl border border-edge bg-surface px-4 py-2">
        {data.topSellers.length === 0 && <p className="py-2 text-ink-muted">No sales yet this week.</p>}
        {data.topSellers.map((t, i) => (
          <div key={t.name} className="flex justify-between border-b border-edge py-2 last:border-0">
            <span>
              {i + 1}. {t.name}
            </span>
            <span className="text-ink-muted">{t.qtyBase} units</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-edge bg-surface px-4 py-3">
      <div className="text-xs font-semibold tracking-wide text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

// fixed 14-day window ending today (module scope keeps render pure)
const WINDOW_14D: string[] = (() => {
  const now = Date.now();
  return Array.from({ length: 14 }, (_, i) =>
    new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10),
  );
})();

function Sparkline({ days }: { days: { day: string; gross: string }[] }) {
  // pad to the full window so one busy day doesn't fill the chart
  const byDay = new Map(days.map((d) => [d.day, Number(d.gross)]));
  const labels = WINDOW_14D;
  const points = labels.map((day) => byDay.get(day) ?? 0);
  const w = 560;
  const h = 80;
  const max = Math.max(...points, 1);
  const bar = w / points.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 16}`} className="w-full" role="img" aria-label="Daily sales, last 14 days">
      {points.map((p, i) => {
        const bh = Math.max((p / max) * h, p > 0 ? 3 : 1);
        return (
          <g key={i}>
            <rect
              x={i * bar + 3}
              y={h - bh}
              width={bar - 6}
              height={bh}
              rx={2}
              className="fill-primary"
              opacity={0.85}
            >
              <title>{`${labels[i]}: GHS ${p.toFixed(2)}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
