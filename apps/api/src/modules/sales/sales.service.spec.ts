import { Prisma } from '@prisma/client';
import { SalesService } from './sales.service';
import { DomainException } from '../../common/domain.exception';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../../common/jwt-auth.guard';
import type { SaleCreateDto } from './dto';

/**
 * Unit coverage for the one function that carries the most business risk in
 * the whole app: FEFO batch allocation + discount/payment gating inside
 * SalesService.createSale. Previously only exercised end-to-end (needs a
 * live Postgres); these run in milliseconds against a mocked Prisma client.
 *
 * $transaction is mocked as `(cb) => cb(tx)` — this proves the allocation
 * math and the guard clauses fire with the right codes, but (unlike a real
 * DB) it does not prove atomic rollback on a mid-transaction throw. That
 * property is still e2e territory.
 */

interface LockedBatchFixture {
  id: string;
  qty_on_hand: number;
  unit_cost: Prisma.Decimal;
  expiry_date: Date;
}

function makeBatch(overrides: Partial<LockedBatchFixture> = {}): LockedBatchFixture {
  return {
    id: 'batch-1',
    qty_on_hand: 100,
    unit_cost: new Prisma.Decimal('1.50'),
    expiry_date: new Date('2027-01-01'),
    ...overrides,
  };
}

function makeProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prod-1',
    name: 'Paracetamol 500mg',
    vatApplies: false,
    units: [] as unknown[],
    ...overrides,
  };
}

function makeActor(role: RequestUser['role'] = 'CASHIER'): RequestUser {
  return { id: 'user-1', username: 'akosua', role };
}

function makeDto(overrides: Partial<SaleCreateDto> = {}): SaleCreateDto {
  return {
    clientSaleId: 'a0000000-0000-0000-0000-000000000001',
    soldAt: new Date().toISOString(),
    items: [{ productId: 'prod-1', quantity: 2, unitPrice: '5.00' } as SaleCreateDto['items'][number]],
    payments: [{ method: 'CASH', amount: '10.00' } as SaleCreateDto['payments'][number]],
    ...overrides,
  } as SaleCreateDto;
}

/** Tagged-template-aware $queryRaw stub: routes on SQL shape, not call order. */
function makeQueryRawMock(batchesByProduct: Map<string, LockedBatchFixture[]>) {
  return jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('');
    if (sql.includes('FROM batches')) {
      const productId = values[0] as string;
      return Promise.resolve(batchesByProduct.get(productId) ?? []);
    }
    if (sql.includes('nextval')) {
      return Promise.resolve([{ nextval: 1n }]);
    }
    throw new Error(`Unexpected $queryRaw in test: ${sql}`);
  });
}

/** Tracks batch.qtyOnHand across decrement calls so depletion (→ DEPLETED) is observable. */
function makeBatchUpdateMock(initialQty: Record<string, number>) {
  const state = { ...initialQty };
  const calls: { id: string; data: Record<string, unknown> }[] = [];
  const fn = jest.fn(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    calls.push({ id: where.id, data });
    const dec = (data.qtyOnHand as { decrement?: number } | undefined)?.decrement;
    if (dec !== undefined) state[where.id] -= dec;
    return Promise.resolve({ qtyOnHand: state[where.id] });
  });
  return { fn, calls, state };
}

function buildHarness(opts: {
  batchesByProduct?: Map<string, LockedBatchFixture[]>;
  batchInitialQty?: Record<string, number>;
  products?: ReturnType<typeof makeProduct>[];
  existingSale?: unknown;
  expiredCount?: number;
  findFirstBatch?: { id: string } | null;
}) {
  const batchesByProduct = opts.batchesByProduct ?? new Map();
  const batchUpdate = makeBatchUpdateMock(opts.batchInitialQty ?? {});

  const tx = {
    product: { findMany: jest.fn().mockResolvedValue(opts.products ?? [makeProduct()]) },
    $queryRaw: makeQueryRawMock(batchesByProduct),
    batch: {
      count: jest.fn().mockResolvedValue(opts.expiredCount ?? 0),
      findFirst: jest.fn().mockResolvedValue(opts.findFirstBatch ?? null),
      update: batchUpdate.fn,
    },
    notification: { create: jest.fn().mockResolvedValue(undefined) },
    sale: { create: jest.fn().mockResolvedValue(undefined) },
    saleItem: { create: jest.fn().mockResolvedValue(undefined) },
    stockMovement: { create: jest.fn().mockResolvedValue(undefined) },
    payment: { create: jest.fn().mockResolvedValue(undefined) },
  };

  const saleStub = (actor: RequestUser) => ({
    id: 'sale-1',
    clientSaleId: 'a0000000-0000-0000-0000-000000000001',
    receiptNumber: 'RCP-2026-000001',
    cashierId: actor.id,
    status: 'COMPLETED',
    subtotal: new Prisma.Decimal('10.00'),
    discountTotal: new Prisma.Decimal('0'),
    vatTotal: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('10.00'),
    soldAt: new Date(),
    syncedOffline: false,
    cashier: { fullName: 'Akosua Mensah' },
    items: [],
    payments: [],
  });

  const prisma = {
    sale: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { clientSaleId?: string; id?: string } }) => {
        if (where.clientSaleId !== undefined) return Promise.resolve(opts.existingSale ?? null);
        return Promise.resolve(saleStub(makeActor()));
      }),
    },
    setting: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  const service = new SalesService(prisma as unknown as PrismaService, audit as unknown as AuditService);

  // getSale's own prisma.sale.findUnique (by id) must reflect the acting cashier
  // so assertCanView doesn't reject the stub for CASHIER actors.
  const setFinalSaleActor = (actor: RequestUser) => {
    prisma.sale.findUnique.mockImplementation(({ where }: { where: { clientSaleId?: string; id?: string } }) => {
      if (where.clientSaleId !== undefined) return Promise.resolve(opts.existingSale ?? null);
      return Promise.resolve(saleStub(actor));
    });
  };

  return { prisma, tx, audit, service, batchUpdate, setFinalSaleActor };
}

/** Asserts a DomainException with the given machine-readable code, via the
 *  public HttpException API (getResponse()) rather than relying on the
 *  internal field name. */
async function expectDomainCode(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainException);
  expect((caught as DomainException).getResponse()).toEqual(expect.objectContaining({ code }));
}

describe('SalesService.createSale — FEFO allocation', () => {
  it('allocates from a single batch and decrements qtyOnHand', async () => {
    const batch = makeBatch({ id: 'batch-1', qty_on_hand: 20 });
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', [batch]]]),
      batchInitialQty: { 'batch-1': 20 },
    });
    const actor = makeActor('CASHIER');
    h.setFinalSaleActor(actor);

    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 5, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '25.00' } as never],
    });
    await h.service.createSale(dto, actor);

    expect(h.tx.saleItem.create).toHaveBeenCalledTimes(1);
    expect(h.tx.saleItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch-1', qtyBase: 5, quantity: 5 }) }),
    );
    expect(h.tx.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch-1', qtyDelta: -5, type: 'SALE' }) }),
    );
    expect(h.batchUpdate.state['batch-1']).toBe(15);
  });

  it('sets a batch to DEPLETED once its qtyOnHand reaches zero', async () => {
    const batch = makeBatch({ id: 'batch-1', qty_on_hand: 5 });
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', [batch]]]),
      batchInitialQty: { 'batch-1': 5 },
    });
    const actor = makeActor('CASHIER');
    h.setFinalSaleActor(actor);

    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 5, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '25.00' } as never],
    });
    await h.service.createSale(dto, actor);

    const statusCall = h.batchUpdate.calls.find((c) => c.data.status !== undefined);
    expect(statusCall).toEqual({ id: 'batch-1', data: { status: 'DEPLETED' } });
  });

  it('splits a line across batches in FEFO order (earliest expiry first)', async () => {
    const earlier = makeBatch({ id: 'batch-early', qty_on_hand: 5, expiry_date: new Date('2026-08-01') });
    const later = makeBatch({ id: 'batch-late', qty_on_hand: 20, expiry_date: new Date('2026-12-01') });
    const h = buildHarness({
      // pre-sorted earliest-expiry-first, exactly as the real ORDER BY would return
      batchesByProduct: new Map([['prod-1', [earlier, later]]]),
      batchInitialQty: { 'batch-early': 5, 'batch-late': 20 },
    });
    const actor = makeActor('CASHIER');
    h.setFinalSaleActor(actor);

    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 12, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '60.00' } as never],
    });
    await h.service.createSale(dto, actor);

    expect(h.tx.saleItem.create).toHaveBeenCalledTimes(2);
    const calls = h.tx.saleItem.create.mock.calls.map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data);

    // first split carries the full requested quantity + the real money fields
    expect(calls[0]).toEqual(
      expect.objectContaining({ batchId: 'batch-early', qtyBase: 5, quantity: 12, unitPrice: new Prisma.Decimal('5.00') }),
    );
    // remainder splits carry qty-in-that-batch as "quantity" and zeroed money (so receipt totals stay exact)
    expect(calls[1]).toEqual(
      expect.objectContaining({ batchId: 'batch-late', qtyBase: 7, quantity: 7, unitPrice: new Prisma.Decimal(0) }),
    );

    expect(h.batchUpdate.state['batch-early']).toBe(0);
    expect(h.batchUpdate.state['batch-late']).toBe(13);
  });

  it('throws INSUFFICIENT_STOCK online when active stock is short and nothing is expired', async () => {
    const batch = makeBatch({ id: 'batch-1', qty_on_hand: 3 });
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', [batch]]]),
      batchInitialQty: { 'batch-1': 3 },
      expiredCount: 0,
    });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 10, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '50.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'INSUFFICIENT_STOCK');
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('throws BATCH_EXPIRED online when the shortfall is explained by expired stock', async () => {
    // no ACTIVE batches returned (all expired ⇒ excluded by the FEFO query itself)
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', []]]),
      expiredCount: 1,
    });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 10, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '50.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'BATCH_EXPIRED');
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('offline: drives the batch negative and raises NEG_STOCK_EXCEPTION instead of failing', async () => {
    const batch = makeBatch({ id: 'batch-1', qty_on_hand: 3 });
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', [batch]]]),
      batchInitialQty: { 'batch-1': 3 },
    });
    const actor = makeActor('CASHIER');
    h.setFinalSaleActor(actor);

    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 10, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '50.00' } as never],
    });
    const result = await h.service.createSale(dto, actor, /* offline */ true);

    expect(result.duplicate).toBe(false);
    expect(h.tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'NEG_STOCK_EXCEPTION',
          payload: expect.objectContaining({ productId: 'prod-1', qtyShort: 7 }),
        }),
      }),
    );
    // the shortfall is folded into the existing allocation, not a second sale item
    expect(h.tx.saleItem.create).toHaveBeenCalledTimes(1);
    expect(h.tx.saleItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ batchId: 'batch-1', qtyBase: 10 }) }),
    );
    expect(h.batchUpdate.state['batch-1']).toBe(-7);
  });

  it('offline: throws NO_BATCH when the product has no batch at all to record against', async () => {
    const h = buildHarness({
      batchesByProduct: new Map([['prod-1', []]]),
      findFirstBatch: null,
    });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 10, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '50.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor, true), 'NO_BATCH');
  });
});

describe('SalesService.createSale — discount gating & payments', () => {
  const oneBatch = () => new Map([['prod-1', [makeBatch({ id: 'batch-1', qty_on_hand: 100 })]]]);
  const qty = { 'batch-1': 100 };

  it('rejects a discount from a CASHIER', async () => {
    const h = buildHarness({ batchesByProduct: oneBatch(), batchInitialQty: qty });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 1, unitPrice: '5.00', discount: '1.00' } as never],
      payments: [{ method: 'CASH', amount: '4.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'DISCOUNT_FORBIDDEN');
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('allows a discount from a PHARMACIST and applies it to the line total', async () => {
    const h = buildHarness({ batchesByProduct: oneBatch(), batchInitialQty: qty });
    const actor = makeActor('PHARMACIST');
    h.setFinalSaleActor(actor);
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 1, unitPrice: '5.00', discount: '1.00' } as never],
      payments: [{ method: 'CASH', amount: '4.00' } as never],
    });

    await h.service.createSale(dto, actor);

    expect(h.tx.saleItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discount: new Prisma.Decimal('1.00'), lineTotal: new Prisma.Decimal('4.00') }),
      }),
    );
  });

  it('rejects a discount larger than the line amount', async () => {
    const h = buildHarness({ batchesByProduct: oneBatch(), batchInitialQty: qty });
    const actor = makeActor('MANAGER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 1, unitPrice: '5.00', discount: '9.00' } as never],
      payments: [{ method: 'CASH', amount: '0.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'DISCOUNT_EXCEEDS_LINE');
  });

  it('rejects payments that do not add up to the sale total', async () => {
    const h = buildHarness({ batchesByProduct: oneBatch(), batchInitialQty: qty });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 1, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '4.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'PAYMENT_MISMATCH');
    expect(h.tx.sale.create).not.toHaveBeenCalled();
  });

  it('rejects a tendered amount below the amount due', async () => {
    const h = buildHarness({ batchesByProduct: oneBatch(), batchInitialQty: qty });
    const actor = makeActor('CASHIER');
    const dto = makeDto({
      items: [{ productId: 'prod-1', quantity: 1, unitPrice: '5.00' } as never],
      payments: [{ method: 'CASH', amount: '5.00', tendered: '2.00' } as never],
    });

    await expectDomainCode(h.service.createSale(dto, actor), 'TENDERED_TOO_LOW');
  });

  it('is idempotent: a repeated clientSaleId returns the existing sale without re-running the transaction', async () => {
    const h = buildHarness({
      batchesByProduct: oneBatch(),
      batchInitialQty: qty,
      existingSale: { id: 'sale-1' },
    });
    const actor = makeActor('CASHIER');
    h.setFinalSaleActor(actor);

    const result = await h.service.createSale(makeDto(), actor);

    expect(result.duplicate).toBe(true);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
