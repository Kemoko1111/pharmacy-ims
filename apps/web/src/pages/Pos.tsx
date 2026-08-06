import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { v7 as uuidv7 } from '../lib/uuid';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useBarcodeWedge } from '../lib/barcodeWedge';
import {
  CachedProduct,
  lookupBarcodeOffline,
  queueSale,
  searchCatalogOffline,
} from '../lib/offline';
import { CartLine, cartTotals, useCart } from '../stores/cart';
import { canUseServer } from '../lib/connectivity';
import { db } from '../lib/offline';
import { fromP, ghs, toP } from '../lib/format';
import { PaymentDialog } from '../components/PaymentDialog';
import { HoldRecallDialog } from '../components/HoldRecallDialog';
import { useDebounced } from '../lib/useDebounced';

async function searchProducts(q: string): Promise<CachedProduct[]> {
  // Reachability, not link state: a till on shop WiFi with a dead uplink used
  // to wait out the full request before falling back to the cache here.
  if (!canUseServer()) return searchCatalogOffline(q);
  try {
    const res = await api<{ data: CachedProduct[] }>(`/products?q=${encodeURIComponent(q)}&pageSize=20`);
    return res.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    return searchCatalogOffline(q); // network down mid-session
  }
}

export default function Pos() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const cart = useCart();
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 200);
  const [highlight, setHighlight] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    if (!holdOpen) {
      const branchId = user.activeBranch?.id ?? '';
      db.heldSales
        .where('cashierId')
        .equals(user.id)
        .and((h) => h.branchId === branchId)
        .count()
        .then(setHeldCount)
        .catch(() => {});
    }
  }, [user, holdOpen, user?.activeBranch?.id]);

  const { data: results = [] } = useQuery({
    queryKey: ['pos-search', debouncedQ],
    queryFn: () => searchProducts(debouncedQ),
    enabled: debouncedQ.length >= 2,
    // run even while offline — searchProducts falls back to the Dexie
    // catalogue itself (react-query's default networkMode would pause it)
    networkMode: 'always',
    retry: false,
  });

  const totals = useMemo(() => cartTotals(cart.lines), [cart.lines]);

  const addProduct = useCallback(
    (p: CachedProduct, unitId: string | null) => {
      const unit = unitId ? p.units.find((u) => u.id === unitId) : null;
      cart.add({
        productId: p.id,
        name: p.strength ? `${p.name}` : p.name,
        unitId: unit?.id ?? null,
        unitName: unit?.unitName ?? p.baseUnit,
        unitPrice: unit?.sellingPrice ?? p.sellingPriceBase,
        vatApplies: p.vatApplies,
        maxQtyBase: p.qtyOnHand,
        factorToBase: unit?.factorToBase ?? 1,
      });
      setQ('');
      searchRef.current?.focus();
    },
    [cart],
  );

  // ── Barcode wedge: resolve → add, regardless of focus (ADR-008) ────────────
  const onScan = useCallback(
    async (code: string) => {
      try {
        if (canUseServer()) {
          const hit = await api<{ product: CachedProduct & { units: CachedProduct['units'] }; unit: { id: string } | null }>(
            `/barcodes/${encodeURIComponent(code)}`,
          );
          addProduct(hit.product, hit.unit?.id ?? null);
          return;
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setQ(code); // US-06 AC1: unknown barcode → prompt search
          searchRef.current?.focus();
          return;
        }
      }
      const local = await lookupBarcodeOffline(code);
      if (local) addProduct(local.product, local.unitId);
      else {
        setQ(code);
        searchRef.current?.focus();
      }
    },
    [addProduct],
  );
  useBarcodeWedge(onScan);

  // ── Keyboard map (wireframes §Keyboard shortcuts) ──────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // A modal owns the keyboard while it is up — F2 behind the payment dialog
      // used to clear the very cart being paid for.
      if (payOpen || holdOpen) return;
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'F2') {
        e.preventDefault();
        cart.clear();
        setQ('');
        searchRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        if (cart.lines.length > 0) setPayOpen(true);
      } else if (e.key === 'F6' && cart.selectedKey) {
        e.preventDefault();
        document.getElementById(`qty-${cart.selectedKey}`)?.focus();
      } else if (e.key === 'F8' && cart.selectedKey) {
        e.preventDefault();
        document.getElementById(`disc-${cart.selectedKey}`)?.focus();
      } else if (e.key === 'F9') {
        e.preventDefault();
        setHoldOpen((o) => !o);
      } else if (e.key === 'Delete' && cart.selectedKey) {
        const target = document.activeElement?.tagName;
        if (target !== 'INPUT') {
          e.preventDefault();
          cart.remove(cart.selectedKey);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [cart, payOpen, holdOpen]);

  // search-list arrow navigation
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && results[highlight]) {
      e.preventDefault();
      addProduct(results[highlight], null);
    }
  };

  // ── Submit sale: online direct, otherwise append-only local queue ─────────
  const completeSale = async (payment: {
    method: 'CASH' | 'MOMO';
    tenderedP: number | null;
    customerId: string | null;
  }) => {
    const body = {
      clientSaleId: uuidv7(),
      soldAt: new Date().toISOString(),
      ...(payment.customerId ? { customerId: payment.customerId } : {}),
      items: cart.lines.map((l) => ({
        productId: l.productId,
        productUnitId: l.unitId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount || '0',
      })),
      payments: [
        {
          method: payment.method,
          amount: fromP(totals.totalP),
          ...(payment.tenderedP !== null ? { tendered: fromP(payment.tenderedP) } : {}),
        },
      ],
    };

    const localReceipt = {
      offline: true,
      sale: {
        receiptNumber: `OFFLINE-${body.clientSaleId.slice(-8).toUpperCase()}`,
        soldAt: body.soldAt,
        cashierName: user?.fullName ?? '',
        items: cart.lines.map((l) => ({
          productName: l.name,
          unitName: l.unitName,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount || '0',
          lineTotal: fromP(toP(l.unitPrice) * l.quantity - toP(l.discount || '0')),
        })),
        subtotal: fromP(totals.subtotalP),
        discountTotal: fromP(totals.discountP),
        total: fromP(totals.totalP),
        payments: [
          {
            method: payment.method,
            amount: fromP(totals.totalP),
            tendered: payment.tenderedP !== null ? fromP(payment.tenderedP) : null,
            changeDue: payment.tenderedP !== null ? fromP(payment.tenderedP - totals.totalP) : null,
          },
        ],
      },
    };

    try {
      if (!canUseServer()) throw new Error('offline');
      // Shorter than the app-wide default: a queued sale prints instantly and
      // syncs later, so waiting 15 s at the till buys nothing but a queue of
      // customers. api() turns the timeout into a NetworkError, i.e. the
      // offline path below.
      const sale = await api<{ id: string }>('/sales', { method: 'POST', body, timeoutMs: 7_000 });
      cart.clear();
      setPayOpen(false);
      navigate('/receipt', { state: { saleId: (sale as { id: string }).id, print: true } });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        // domain refusal (insufficient stock, expired…) — show it, keep the cart
        setNotice(err.message);
        setPayOpen(false);
        return;
      }
      // network failure or offline → queue (ADR-006), print local receipt
      // Stamp the branch the money was actually taken at (ADR-010) — the token
      // may point somewhere else by the time the queue drains.
      await queueSale({
        clientSaleId: body.clientSaleId,
        branchId: user?.activeBranch?.id ?? '',
        body: body as never,
        queuedAt: new Date().toISOString(),
        cashierName: user?.fullName ?? '',
      });
      cart.clear();
      setPayOpen(false);
      navigate('/receipt', { state: { local: localReceipt, print: true } });
    }
  };

  return (
    <div className="flex min-h-full flex-col lg:h-full lg:flex-row">
      {/* ── Left: search + results ─────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col border-b border-edge p-4 lg:border-b-0 lg:border-r">
        <input
          ref={searchRef}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={onSearchKey}
          placeholder="🔍  Scan barcode or type name / generic…  ( / )"
          className="w-full rounded-lg border border-edge bg-surface px-4 py-3 text-lg outline-none focus:border-primary"
        />

        {notice && (
          <div className="mt-3 flex items-center justify-between rounded-lg bg-danger/10 px-4 py-2 text-danger">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="font-bold">✕</button>
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-auto max-lg:flex-none max-lg:overflow-visible">
          {results.map((p, i) => {
            const low = p.qtyOnHand <= (('reorderLevel' in p ? (p as { reorderLevel?: number }).reorderLevel : 0) ?? 0);
            const out = p.qtyOnHand <= 0;
            return (
              <div
                key={p.id}
                onClick={() => !out && addProduct(p, null)}
                className={`cursor-pointer rounded-lg border px-4 py-3 ${
                  i === highlight ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-surface'
                } ${out ? 'opacity-50' : ''}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {p.strength && <span className="text-sm text-ink-muted">{p.strength}</span>}
                  {p.prescriptionOnly && (
                    <span className="rounded bg-danger/10 px-1.5 text-xs font-semibold text-danger">Rx</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!out) addProduct(p, null);
                    }}
                    className="rounded-full border border-edge px-2.5 py-0.5 hover:border-primary hover:text-primary"
                  >
                    {p.baseUnit} {ghs(p.sellingPriceBase)}
                  </button>
                  {p.units.map((u) => (
                    <button
                      key={u.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!out) addProduct(p, u.id);
                      }}
                      className="rounded-full border border-edge px-2.5 py-0.5 hover:border-primary hover:text-primary"
                    >
                      {u.unitName} {ghs(u.sellingPrice)}
                    </button>
                  ))}
                  <span className={`ml-auto ${out ? 'text-danger font-semibold' : low ? 'text-warn font-semibold' : 'text-ink-muted'}`}>
                    {out ? 'OUT OF STOCK' : low ? `⚠ LOW: ${p.qtyOnHand} ${p.baseUnit}` : `Stock: ${p.qtyOnHand} ${p.baseUnit}`}
                    {p.nearestExpiry ? ` · exp ${p.nearestExpiry.slice(0, 7)}` : ''}
                  </span>
                </div>
              </div>
            );
          })}
          {debouncedQ.length >= 2 && results.length === 0 && (
            <p className="p-4 text-ink-muted">No products match “{debouncedQ}”.</p>
          )}
        </div>

        <p className="pt-2 text-sm text-ink-muted">
          [F2 New] [F4 Payment] [F6 Qty] [F8 Disc] [Del Remove] — scanner works from anywhere
        </p>
      </section>

      {/* ── Right: the sale ───────────────────────────────────────────────── */}
      <section className="flex w-full shrink-0 flex-col bg-surface lg:w-[26rem]">
        <div className="flex items-center border-b border-edge px-4 py-3 font-semibold">
          SALE <span className="ml-1 text-ink-muted">(new)</span>
          {heldCount > 0 && (
            <button
              onClick={() => setHoldOpen(true)}
              className="ml-auto rounded-full bg-warn/15 px-2.5 py-0.5 text-sm font-semibold text-warn"
              title="Recall a held sale (F9)"
            >
              ⏸ {heldCount} on hold
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-2 py-2 max-lg:flex-none max-lg:overflow-visible">
          {cart.lines.length === 0 && (
            <p className="p-4 text-center text-ink-muted">Scan an item or search to begin</p>
          )}
          {cart.lines.map((l) => (
            <CartRow key={l.key} line={l} selected={cart.selectedKey === l.key} />
          ))}
        </div>

        <div className="border-t border-edge px-4 py-3 text-[15px]">
          <div className="flex justify-between text-ink-muted">
            <span>Subtotal</span>
            <span>{ghs(fromP(totals.subtotalP))}</span>
          </div>
          <div className="flex justify-between text-ink-muted">
            <span>Discounts</span>
            <span>−{ghs(fromP(totals.discountP))}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between text-xl font-bold">
            <span>TOTAL</span>
            <span>{ghs(fromP(totals.totalP))}</span>
          </div>
          <button
            onClick={() => setPayOpen(true)}
            disabled={cart.lines.length === 0}
            className="mt-3 w-full rounded-lg bg-primary py-3 text-lg font-bold text-white disabled:opacity-40 dark:text-slate-900"
          >
            F4 · PAYMENT
          </button>
        </div>
      </section>

      {payOpen && (
        <PaymentDialog totalP={totals.totalP} onConfirm={completeSale} onClose={() => setPayOpen(false)} />
      )}
      {holdOpen && user && <HoldRecallDialog cashierId={user.id} onClose={() => setHoldOpen(false)} />}
    </div>
  );
}

function CartRow({ line, selected }: { line: CartLine; selected: boolean }) {
  const cart = useCart();
  const { user } = useAuth();
  // F8 discounts are role-gated: cashiers ring full price (server enforces too)
  const canDiscount = user?.role !== 'CASHIER';
  const lineTotalP = toP(line.unitPrice) * line.quantity - toP(line.discount || '0');
  return (
    <div
      onClick={() => cart.select(line.key)}
      className={`mb-1 cursor-pointer rounded-lg border px-3 py-2 ${
        selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-bg'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{line.name}</span>
        <span className="font-semibold">{ghs(fromP(lineTotalP))}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-sm text-ink-muted">
        <input
          id={`qty-${line.key}`}
          type="number"
          min={0}
          value={line.quantity}
          onChange={(e) => cart.setQty(line.key, Number(e.target.value))}
          className="w-16 rounded border border-edge bg-bg px-1.5 py-0.5 text-center"
        />
        <span>× {line.unitName} @ {ghs(line.unitPrice)}</span>
        {canDiscount && (
          <label className="ml-auto flex items-center gap-1">
            disc
            <input
              id={`disc-${line.key}`}
              type="number"
              min={0}
              step="0.1"
              value={line.discount}
              onChange={(e) => cart.setDiscount(line.key, e.target.value)}
              className="w-16 rounded border border-edge bg-bg px-1.5 py-0.5 text-center"
            />
          </label>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            cart.remove(line.key);
          }}
          className={`${canDiscount ? '' : 'ml-auto '}text-danger`}
          title="Remove line (Del)"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
