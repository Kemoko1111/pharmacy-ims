import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { ghs, shortDate, timeOf } from '../lib/format';

interface ReceiptSale {
  receiptNumber: string;
  soldAt: string;
  cashierName: string;
  subtotal: string;
  discountTotal: string;
  vatTotal?: string;
  total: string;
  items: {
    productName: string;
    unitName: string;
    quantity: number;
    unitPrice: string;
    discount: string;
    lineTotal: string;
  }[];
  payments: { method: string; amount: string; tendered: string | null; changeDue: string | null }[];
}

interface Header {
  line1?: string;
  line2?: string;
  line3?: string;
}

/**
 * Print-dedicated route (ADR-008): 80 mm @media print CSS, browser dialog.
 * Arrives with router state: { saleId, print } (online) or { local } (queued).
 */
export default function Receipt() {
  const { state } = useLocation() as {
    state?: { saleId?: string; print?: boolean; local?: { offline: true; sale: ReceiptSale }; reprint?: boolean };
  };

  const { data } = useQuery({
    queryKey: ['receipt', state?.saleId, state?.reprint],
    queryFn: () =>
      api<{ header: Header; sale: ReceiptSale; reprint: boolean }>(
        `/sales/${state!.saleId}/receipt${state?.reprint ? '?reprint=true' : ''}`,
      ),
    enabled: !!state?.saleId,
  });

  const sale = state?.local?.sale ?? data?.sale;
  const header: Header = data?.header ?? { line1: 'PharmaTrack' };
  const offline = !!state?.local;
  const reprint = !!state?.reprint;

  useEffect(() => {
    if (state?.print && sale) {
      const id = setTimeout(() => window.print(), 300);
      return () => clearTimeout(id);
    }
  }, [state?.print, sale]);

  if (!sale) {
    return (
      <div className="grid h-full place-items-center text-ink-muted">
        No receipt to show. <Link className="ml-2 text-primary underline" to="/pos">Back to POS</Link>
      </div>
    );
  }

  const payment = sale.payments[0];

  return (
    <div className="min-h-full bg-bg p-6">
      <div className="mx-auto mb-4 flex max-w-xs justify-between print:hidden">
        <Link to="/pos" className="rounded border border-edge px-3 py-1.5 text-sm">← POS</Link>
        <button
          onClick={() => window.print()}
          className="rounded bg-primary px-4 py-1.5 text-sm font-semibold text-white dark:text-slate-900"
        >
          Print
        </button>
      </div>

      <div id="receipt" className="mx-auto max-w-xs bg-white p-4 font-mono text-[12px] text-black shadow">
        <div className="text-center">
          <div className="text-sm font-bold">{header.line1 ?? 'PharmaTrack'}</div>
          {header.line2 && <div>{header.line2}</div>}
          {header.line3 && <div>{header.line3}</div>}
        </div>
        <hr className="my-2 border-dashed border-black" />
        <div className="flex justify-between">
          <span>{sale.receiptNumber}</span>
          <span>
            {shortDate(sale.soldAt)} {timeOf(sale.soldAt)}
          </span>
        </div>
        <div>Cashier: {sale.cashierName}</div>
        {offline && <div className="font-bold">** OFFLINE — PENDING SYNC **</div>}
        {reprint && <div className="font-bold">** REPRINT **</div>}
        <hr className="my-2 border-dashed border-black" />

        {sale.items
          .filter((i) => Number(i.lineTotal) > 0 || i.quantity > 0)
          .map((i, idx) => (
            <div key={idx} className="mb-1">
              <div>{i.productName}</div>
              <div className="flex justify-between">
                <span>
                  {i.quantity} {i.unitName} × {Number(i.unitPrice).toFixed(2)}
                  {Number(i.discount) > 0 ? ` −${Number(i.discount).toFixed(2)}` : ''}
                </span>
                <span>{Number(i.lineTotal).toFixed(2)}</span>
              </div>
            </div>
          ))}

        <hr className="my-2 border-dashed border-black" />
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{Number(sale.subtotal).toFixed(2)}</span>
        </div>
        {Number(sale.discountTotal) > 0 && (
          <div className="flex justify-between">
            <span>Discount</span>
            <span>−{Number(sale.discountTotal).toFixed(2)}</span>
          </div>
        )}
        {sale.vatTotal !== undefined && Number(sale.vatTotal) > 0 && (
          <div className="flex justify-between">
            <span>of which VAT</span>
            <span>{Number(sale.vatTotal).toFixed(2)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-bold">
          <span>TOTAL</span>
          <span>{ghs(sale.total)}</span>
        </div>

        {payment && (
          <>
            <div className="mt-1 flex justify-between">
              <span>{payment.method}</span>
              <span>{Number(payment.amount).toFixed(2)}</span>
            </div>
            {payment.tendered && (
              <div className="flex justify-between">
                <span>Tendered / Change</span>
                <span>
                  {Number(payment.tendered).toFixed(2)} / {Number(payment.changeDue ?? 0).toFixed(2)}
                </span>
              </div>
            )}
          </>
        )}

        <hr className="my-2 border-dashed border-black" />
        <div className="text-center">Thank you — get well soon!</div>
      </div>
    </div>
  );
}
