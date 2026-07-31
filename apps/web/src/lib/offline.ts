/**
 * Offline strategy (ADR-006): read-only catalogue snapshot + append-only sale
 * queue in IndexedDB. The server stays the single source of truth; the queue
 * drains through the idempotent POST /sync/sales.
 *
 * Multi-branch (ADR-010): `qtyOnHand` and `nearestExpiry` describe one branch's
 * shelves, so every cached row and every queued sale is stamped with the branch
 * it belongs to. Without that, switching branch would show one shop the other's
 * stock, and a queued sale would sync against whichever branch happened to be
 * active when the network came back.
 */
import Dexie, { type Table } from 'dexie';
import type { SaleCreate } from '@pharmatrack/shared';
import { api } from './api';

export interface CachedProduct {
  id: string;
  /** Compound key with `id` — the same product is cached per branch. */
  branchId: string;
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
  /** Where the money was actually taken — fixed at enqueue time. */
  branchId: string;
  body: SaleCreate;
  queuedAt: string;
  cashierName: string;
}

export interface HeldSale {
  id: string;
  branchId: string;
  heldAt: string;
  cashierId: string;
  label: string; // first line + count, shown in the recall list
  lines: unknown[]; // CartLine[] — stored opaque to avoid a store↔lib cycle
}

class PtDb extends Dexie {
  catalog!: Table<CachedProduct, [string, string]>;
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
    // ADR-010: catalogue is keyed per branch, and the queue records its origin.
    this.version(3)
      .stores({
        catalog: '[branchId+id], branchId, name, genericName',
        saleQueue: 'clientSaleId, queuedAt, branchId',
        heldSales: 'id, heldAt, cashierId, branchId',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        // Pre-branch rows have no branch and their stock figures cannot be
        // attributed; drop them and let the next online snapshot refill.
        await tx.table('catalog').clear();
        await tx.table('meta').delete('snapshotVersion');
      });
  }
}

export const db = new PtDb();

/**
 * The branch the till is currently working in. Set from the auth session so the
 * helpers below need no extra plumbing at their call sites.
 */
let activeBranchId: string | null = null;

export function setActiveBranch(branchId: string | null): void {
  activeBranchId = branchId;
}

export function getActiveBranch(): string | null {
  return activeBranchId;
}

/** Offline reads are meaningless without a branch — fail loudly, not silently. */
function requireBranch(): string {
  if (!activeBranchId) {
    throw new Error('No active branch — cannot read the offline catalogue');
  }
  return activeBranchId;
}

export async function refreshSnapshot(): Promise<void> {
  // The endpoint is branch-scoped server-side by the token, so what comes back
  // is this branch's stock; stamp it so the cache stays honest after a switch.
  const branchId = requireBranch();
  const snap = await api<{ version: string; products: Omit<CachedProduct, 'branchId'>[] }>(
    '/catalog/snapshot',
  );
  await db.transaction('rw', db.catalog, db.meta, async () => {
    await db.catalog.where('branchId').equals(branchId).delete();
    await db.catalog.bulkAdd(snap.products.map((p) => ({ ...p, branchId })));
    await db.meta.put({ key: `snapshotVersion:${branchId}`, value: snap.version });
  });
}

function branchCatalog() {
  return db.catalog.where('branchId').equals(requireBranch());
}

export async function searchCatalogOffline(q: string, limit = 20): Promise<CachedProduct[]> {
  const needle = q.toLowerCase();
  const all = await branchCatalog().toArray();
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
  const all = await branchCatalog().toArray();
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

/** Sales waiting for the active branch. */
export async function queuedCount(): Promise<number> {
  if (!activeBranchId) return db.saleQueue.count();
  return db.saleQueue.where('branchId').equals(activeBranchId).count();
}

/** Sales stuck because they belong to a branch the till is not currently in. */
export async function queuedElsewhereCount(): Promise<number> {
  if (!activeBranchId) return 0;
  return db.saleQueue.filter((s) => s.branchId !== activeBranchId).count();
}

/**
 * Drain the queue through the idempotent sync endpoint.
 *
 * Only the active branch's sales go up: the access token carries one branch and
 * the server refuses a mismatch, so posting another branch's sales would just
 * fail. They stay queued and are reported as `deferred` — money was already
 * taken at the till, so dropping them is never an option (ADR-010).
 */
export async function drainQueue(): Promise<{ synced: number; failed: number; deferred: number }> {
  const branchId = activeBranchId;
  const all = await db.saleQueue.orderBy('queuedAt').toArray();
  const queued = branchId ? all.filter((s) => s.branchId === branchId) : all;
  const deferred = all.length - queued.length;
  if (queued.length === 0) return { synced: 0, failed: 0, deferred };

  const res = await api<{ results: { clientSaleId: string; status: string }[] }>('/sync/sales', {
    method: 'POST',
    // Send the originating branch so the server can refuse a mismatch rather
    // than trusting that the client filtered correctly.
    body: { sales: queued.map((s) => ({ ...s.body, branchId: s.branchId })) },
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
  return { synced, failed, deferred };
}
