/**
 * Offline strategy (ADR-006): read-only catalogue snapshot + append-only sale
 * queue in IndexedDB. The server stays the single source of truth; the queue
 * drains through the idempotent POST /sync/sales.
 */
import Dexie, { type Table } from 'dexie';
import type { SaleCreate } from '@pharmatrack/shared';
import { api } from './api';

export interface CachedProduct {
  id: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  categoryName: string;
  baseUnit: string;
  sellingPriceBase: string;
  vatApplies: boolean;
  prescriptionOnly: boolean;
  qtyOnHand: number;
  nearestExpiry: string | null;
  units: { id: string; unitName: string; factorToBase: number; sellingPrice: string }[];
  barcodes: { barcode: string; productUnitId: string | null }[];
}

export interface QueuedSale {
  clientSaleId: string;
  body: SaleCreate;
  queuedAt: string;
  cashierName: string;
}

export interface HeldSale {
  id: string;
  heldAt: string;
  cashierId: string;
  label: string; // first line + count, shown in the recall list
  lines: unknown[]; // CartLine[] — stored opaque to avoid a store↔lib cycle
}

class PtDb extends Dexie {
  catalog!: Table<CachedProduct, string>;
  saleQueue!: Table<QueuedSale, string>;
  heldSales!: Table<HeldSale, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super('pharmatrack');
    this.version(1).stores({
      catalog: 'id, name, genericName',
      saleQueue: 'clientSaleId, queuedAt',
      meta: 'key',
    });
    // F9 hold/recall — parked carts survive a reload (till reality: browser
    // crashes mid-queue happen)
    this.version(2).stores({
      catalog: 'id, name, genericName',
      saleQueue: 'clientSaleId, queuedAt',
      heldSales: 'id, heldAt, cashierId',
      meta: 'key',
    });
  }
}

export const db = new PtDb();

export async function refreshSnapshot(): Promise<void> {
  const snap = await api<{ version: string; products: CachedProduct[] }>('/catalog/snapshot');
  await db.transaction('rw', db.catalog, db.meta, async () => {
    await db.catalog.clear();
    await db.catalog.bulkAdd(snap.products);
    await db.meta.put({ key: 'snapshotVersion', value: snap.version });
  });
}

export async function searchCatalogOffline(q: string, limit = 20): Promise<CachedProduct[]> {
  const needle = q.toLowerCase();
  const all = await db.catalog.toArray();
  return all
    .filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.genericName ?? '').toLowerCase().includes(needle) ||
        p.barcodes.some((b) => b.barcode === q),
    )
    .slice(0, limit);
}

export async function lookupBarcodeOffline(code: string) {
  const all = await db.catalog.toArray();
  for (const p of all) {
    const hit = p.barcodes.find((b) => b.barcode === code);
    if (hit) return { product: p, unitId: hit.productUnitId };
  }
  return null;
}

export async function queueSale(sale: QueuedSale): Promise<void> {
  await db.saleQueue.put(sale);
  window.dispatchEvent(new Event('pt-queue-changed'));
}

export async function queuedCount(): Promise<number> {
  return db.saleQueue.count();
}

/** Drain the queue through the idempotent sync endpoint. */
export async function drainQueue(): Promise<{ synced: number; failed: number }> {
  const queued = await db.saleQueue.orderBy('queuedAt').toArray();
  if (queued.length === 0) return { synced: 0, failed: 0 };

  const res = await api<{ results: { clientSaleId: string; status: string }[] }>('/sync/sales', {
    method: 'POST',
    body: { sales: queued.map((s) => s.body) },
  });

  let synced = 0;
  let failed = 0;
  for (const r of res.results) {
    if (r.status === 'created' || r.status === 'duplicate') {
      await db.saleQueue.delete(r.clientSaleId);
      synced++;
    } else {
      failed++;
    }
  }
  window.dispatchEvent(new Event('pt-queue-changed'));
  return { synced, failed };
}
