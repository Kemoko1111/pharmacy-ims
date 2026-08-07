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
import type { OfflineCredential } from './offlineCreds';
import { setCacheBranch } from './offlineCache';

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
  /** Drain attempts so far. A sale that keeps failing must become visible. */
  attempts?: number;
  /** Why the server last refused it, in the words the manager will need. */
  lastError?: string | null;
  lastAttemptAt?: string | null;
}

/**
 * A sale the server has actively rejected this many times is not a transient
 * failure — it needs a human. It stays queued (the money was taken) but is
 * surfaced separately so it stops hiding inside the "unsynced" count.
 */
export const STUCK_AFTER_ATTEMPTS = 3;

/**
 * A write made while the server was unreachable (ADR-013). Durable, not
 * cached: this is work the shop performed and expects to survive a restart,
 * so it lives beside the sale queue rather than in the disposable read cache.
 */
export interface QueuedMutation {
  /** Doubles as the Idempotency-Key, so a retry cannot post twice. */
  opId: string;
  branchId: string;
  method: string;
  path: string;
  body: unknown;
  /** What the cashier did, in their words — this is what the queue screen shows. */
  label: string;
  queuedAt: string;
  actor: string;
  attempts: number;
  /** Set when the server actively refused it; needs a human, not a retry. */
  rejectedAt?: string | null;
  lastError?: string | null;
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
  /** Password verifiers for cold sign-in during an outage — see offlineCreds.ts. */
  offlineAuth!: Table<OfflineCredential, string>;
  /** Writes made offline, waiting to be drained in order (ADR-013). */
  mutationQueue!: Table<QueuedMutation, string>;

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
    // Offline sign-in: only the username is indexed — the verifier is looked up
    // by it and by nothing else.
    this.version(4).stores({
      catalog: '[branchId+id], branchId, name, genericName',
      saleQueue: 'clientSaleId, queuedAt, branchId',
      heldSales: 'id, heldAt, cashierId, branchId',
      offlineAuth: 'username',
      meta: 'key',
    });
    // Offline writes beyond the POS (ADR-013). Ordered by queuedAt on drain,
    // because a create followed by an edit must reach the server that way round.
    this.version(5).stores({
      catalog: '[branchId+id], branchId, name, genericName',
      saleQueue: 'clientSaleId, queuedAt, branchId',
      heldSales: 'id, heldAt, cashierId, branchId',
      offlineAuth: 'username',
      mutationQueue: 'opId, queuedAt, branchId, rejectedAt',
      meta: 'key',
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
  // The read cache is branch-scoped for the same reason this is (ADR-010/013):
  // one shop must never be served another's figures.
  setCacheBranch(branchId);
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
  await stampSync();
}

const LAST_SYNCED_KEY = 'lastSyncedAt';

/**
 * Stamped whenever we have actually reached the server — catalogue pulled down
 * or queued sales pushed up. The client asked to see this: "offline" on its own
 * does not tell a cashier whether the till is minutes or days out of date.
 */
async function stampSync(): Promise<void> {
  await db.meta.put({ key: LAST_SYNCED_KEY, value: new Date().toISOString() });
  window.dispatchEvent(new Event('pt-synced'));
}

export async function getLastSyncedAt(): Promise<string | null> {
  return (await db.meta.get(LAST_SYNCED_KEY))?.value ?? null;
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

export interface QueueSummary {
  /** Waiting for this branch and expected to go through. */
  pending: number;
  /** Belong to another branch — cannot sync until the till switches back. */
  deferred: number;
  /** Repeatedly refused by the server; needs a manager, not another retry. */
  stuck: number;
  /** The most recent refusal, for the tooltip. */
  lastError: string | null;
}

/**
 * One read for everything the status bar needs. "3 unsynced" is not actionable
 * on its own — the cashier has to know whether those are on their way up, sat
 * behind a branch switch, or refused outright.
 */
export async function queueSummary(): Promise<QueueSummary> {
  const all = await db.saleQueue.toArray();
  const mine = activeBranchId ? all.filter((s) => s.branchId === activeBranchId) : all;
  const stuck = mine.filter((s) => (s.attempts ?? 0) >= STUCK_AFTER_ATTEMPTS && s.lastError);
  return {
    pending: mine.length - stuck.length,
    deferred: all.length - mine.length,
    stuck: stuck.length,
    lastError: stuck[stuck.length - 1]?.lastError ?? null,
  };
}

export interface DrainResult {
  synced: number;
  failed: number;
  deferred: number;
}

/** In-flight drain, shared so overlapping triggers collapse into one POST. */
let draining: Promise<DrainResult> | null = null;

/**
 * Drain the queue through the idempotent sync endpoint.
 *
 * Only the active branch's sales go up: the access token carries one branch and
 * the server refuses a mismatch, so posting another branch's sales would just
 * fail. They stay queued and are reported as `deferred` — money was already
 * taken at the till, so dropping them is never an option (ADR-010).
 *
 * Several things can ask for a drain at once (reconnect, a new sale, the tab
 * regaining focus, the retry timer). The endpoint is idempotent so a duplicate
 * post is safe, but it is still wasted bandwidth on a link that has just proven
 * itself weak — so concurrent callers await the same promise.
 */
export function drainQueue(): Promise<DrainResult> {
  draining ??= runDrain().finally(() => {
    draining = null;
  });
  return draining;
}

async function runDrain(): Promise<DrainResult> {
  const branchId = activeBranchId;
  const all = await db.saleQueue.orderBy('queuedAt').toArray();
  const queued = branchId ? all.filter((s) => s.branchId === branchId) : all;
  const deferred = all.length - queued.length;
  if (queued.length === 0) return { synced: 0, failed: 0, deferred };

  const res = await api<{ results: { clientSaleId: string; status: string; error?: string }[] }>(
    '/sync/sales',
    {
      method: 'POST',
      // Send the originating branch so the server can refuse a mismatch rather
      // than trusting that the client filtered correctly.
      body: { sales: queued.map((s) => ({ ...s.body, branchId: s.branchId })) },
      // A shop-wide reconnect can push a whole day of sales at once.
      timeoutMs: 45_000,
    },
  );

  let synced = 0;
  let failed = 0;
  const now = new Date().toISOString();
  for (const r of res.results) {
    if (r.status === 'created' || r.status === 'duplicate') {
      await db.saleQueue.delete(r.clientSaleId);
      synced++;
    } else {
      // Keep it — the money was taken. But record why, so a sale the server
      // will never accept surfaces to a manager instead of retrying silently
      // for the rest of the week.
      const row = queued.find((s) => s.clientSaleId === r.clientSaleId);
      await db.saleQueue.update(r.clientSaleId, {
        attempts: (row?.attempts ?? 0) + 1,
        lastError: r.error ?? r.status,
        lastAttemptAt: now,
      });
      failed++;
    }
  }
  window.dispatchEvent(new Event('pt-queue-changed'));
  await stampSync();
  return { synced, failed, deferred };
}

// ── Offline writes (ADR-013) ────────────────────────────────────────────────

/**
 * Record a write the server could not be reached for. The caller has already
 * been told it is saved, so this must not throw for anything short of a broken
 * database — losing the row silently would mean losing the shop's work.
 */
export async function queueMutation(m: Omit<QueuedMutation, 'attempts'>): Promise<void> {
  await db.mutationQueue.put({ ...m, attempts: 0 });
  window.dispatchEvent(new Event('pt-mutations-changed'));
}

/** Oldest first: a create and the edit that follows it must arrive in that order. */
export async function pendingMutations(): Promise<QueuedMutation[]> {
  const rows = activeBranchId
    ? await db.mutationQueue.where('branchId').equals(activeBranchId).toArray()
    : await db.mutationQueue.toArray();
  return rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export interface MutationQueueSummary {
  /** Waiting to go up. */
  pending: number;
  /** The server refused these; retrying will not help. */
  rejected: number;
}

export async function mutationQueueSummary(): Promise<MutationQueueSummary> {
  const rows = await pendingMutations();
  return {
    pending: rows.filter((r) => !r.rejectedAt).length,
    rejected: rows.filter((r) => r.rejectedAt).length,
  };
}

export async function forgetMutation(opId: string): Promise<void> {
  await db.mutationQueue.delete(opId);
  window.dispatchEvent(new Event('pt-mutations-changed'));
}

/**
 * The server answered and said no. Kept rather than dropped: somebody has to
 * see that the stock count they took during the outage was not accepted, and
 * decide what to do about it.
 */
export async function rejectMutation(opId: string, message: string): Promise<void> {
  await db.mutationQueue.update(opId, {
    rejectedAt: new Date().toISOString(),
    lastError: message,
  });
  window.dispatchEvent(new Event('pt-mutations-changed'));
}

export async function noteMutationAttempt(opId: string, message: string | null): Promise<void> {
  const row = await db.mutationQueue.get(opId);
  if (!row) return;
  await db.mutationQueue.update(opId, { attempts: row.attempts + 1, lastError: message });
}
