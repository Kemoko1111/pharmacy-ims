import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  authHeader,
  createTestApp,
  createUser,
  prisma,
  resetDb,
  saleBody,
  seedCatalog,
  seedSettings,
} from './helpers';

describe('Sales / POS (US-06, US-07, ADR-006)', () => {
  let app: INestApplication;
  let cashier: Record<string, string>;
  let manager: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await seedSettings();
    await createUser('akosua', 'CASHIER');
    await createUser('boss', 'MANAGER');
    app = await createTestApp();
    cashier = await authHeader(app, 'akosua');
    manager = await authHeader(app, 'boss');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('completes a cash sale: FEFO deducts the earliest-expiry batch, writes the ledger, assigns a receipt number', async () => {
    const fix = await seedCatalog();

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(saleBody(fix)); // 2 strips = 20 tablets
    expect(res.status).toBe(201);
    // Branch-code prefixed since ADR-010, still globally unique.
    expect(res.body.receiptNumber).toMatch(/^[A-Z]{2,6}-RCP-\d{4}-\d{6}$/);
    expect(res.body.total).toBe('10');

    // change computed for cash
    expect(res.body.payments[0].changeDue).toBe('10');

    // FEFO: the EARLY batch (30 on hand) loses all 20; LATE untouched
    const early = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    const late = await prisma.batch.findUnique({ where: { id: fix.batchLateId } });
    expect(early?.qtyOnHand).toBe(10);
    expect(late?.qtyOnHand).toBe(100);

    // append-only ledger entry
    const movement = await prisma.stockMovement.findFirst({
      where: { refType: 'sale', refId: res.body.id },
    });
    expect(movement?.qtyDelta).toBe(-20);
    expect(movement?.type).toBe('SALE');
  });

  it('splits a line across batches when the earliest batch runs out, and marks it DEPLETED', async () => {
    const fix = await seedCatalog();

    // 5 strips = 50 tablets > 30 in EARLY → split 30 + 20
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(
        saleBody(fix, {
          items: [
            { productId: fix.productId, productUnitId: fix.stripUnitId, quantity: 5, unitPrice: '5.00' },
          ],
          payments: [{ method: 'CASH', amount: '25.00' }],
        }),
      );
    expect(res.status).toBe(201);

    const early = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    const late = await prisma.batch.findUnique({ where: { id: fix.batchLateId } });
    expect(early?.qtyOnHand).toBe(0);
    expect(early?.status).toBe('DEPLETED');
    expect(late?.qtyOnHand).toBe(80);

    const items = await prisma.saleItem.findMany({ where: { saleId: res.body.id } });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.qtyBase).sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it('is idempotent on clientSaleId: replay returns 409 with the SAME sale, no double stock deduction (ADR-006)', async () => {
    const fix = await seedCatalog();
    const body = saleBody(fix);

    const first = await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(body);
    expect(first.status).toBe(201);

    const replay = await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(body);
    expect(replay.status).toBe(409);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.receiptNumber).toBe(first.body.receiptNumber);

    const early = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(early?.qtyOnHand).toBe(10); // deducted exactly once
  });

  it('refuses domain-rule violations: insufficient stock, payment mismatch, expired-only stock', async () => {
    const fix = await seedCatalog();

    const tooMuch = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(
        saleBody(fix, {
          items: [{ productId: fix.productId, quantity: 500, unitPrice: '0.50' }],
          payments: [{ method: 'CASH', amount: '250.00' }],
        }),
      );
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');

    const wrongPay = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(saleBody(fix, { payments: [{ method: 'CASH', amount: '9.00' }] }));
    expect(wrongPay.status).toBe(422);
    expect(wrongPay.body.error.code).toBe('PAYMENT_MISMATCH');

    // force both batches past expiry → BATCH_EXPIRED, not INSUFFICIENT_STOCK
    const yesterday = new Date(Date.now() - 86_400_000);
    await prisma.batch.updateMany({
      where: { productId: fix.productId },
      data: { expiryDate: yesterday },
    });
    const expired = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(saleBody(fix));
    expect(expired.status).toBe(422);
    expect(expired.body.error.code).toBe('BATCH_EXPIRED');
  });

  it('sync queue: duplicate + created results; oversell records the sale, drives stock negative and raises a Manager exception (ADR-006)', async () => {
    const fix = await seedCatalog();

    const normal = saleBody(fix);
    const first = await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(normal);
    expect(first.status).toBe(201);

    // 20 strips = 200 tablets > 130 total on hand → oversell during "outage"
    const oversell = saleBody(fix, {
      items: [
        { productId: fix.productId, productUnitId: fix.stripUnitId, quantity: 20, unitPrice: '5.00' },
      ],
      payments: [{ method: 'CASH', amount: '100.00' }],
    });

    const sync = await request(app.getHttpServer())
      .post('/api/v1/sync/sales')
      .set(cashier)
      .send({ sales: [normal, oversell] });
    expect(sync.status).toBe(200);
    expect(sync.body.results[0].status).toBe('duplicate');
    expect(sync.body.results[1].status).toBe('created');

    const batches = await prisma.batch.findMany({ where: { productId: fix.productId } });
    const totalOnHand = batches.reduce((s, b) => s + b.qtyOnHand, 0);
    expect(totalOnHand).toBeLessThan(0); // negative stock, surfaced not hidden

    const exception = await prisma.notification.findFirst({
      where: { type: 'NEG_STOCK_EXCEPTION' },
    });
    expect(exception).not.toBeNull();

    const synced = await prisma.sale.findUnique({
      where: { clientSaleId: oversell.clientSaleId as string },
    });
    expect(synced?.syncedOffline).toBe(true);
  });

  it('receipt payload includes header + lines; void restores stock with compensating movements (Manager only)', async () => {
    const fix = await seedCatalog();
    const sale = await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(saleBody(fix));

    const receipt = await request(app.getHttpServer())
      .get(`/api/v1/sales/${sale.body.id}/receipt`)
      .set(cashier);
    expect(receipt.status).toBe(200);
    expect(receipt.body.header.line1).toBe('Test Pharmacy');
    expect(receipt.body.sale.items.length).toBeGreaterThan(0);

    const deniedVoid = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.id}/void`)
      .set(cashier)
      .send({ reason: 'test' });
    expect(deniedVoid.status).toBe(403);

    const beforeVoid = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    const voided = await request(app.getHttpServer())
      .post(`/api/v1/sales/${sale.body.id}/void`)
      .set(manager)
      .send({ reason: 'customer changed mind' });
    expect(voided.status).toBe(201);
    expect(voided.body.status).toBe('VOIDED');

    const afterVoid = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(afterVoid!.qtyOnHand - beforeVoid!.qtyOnHand).toBe(20);

    const compensating = await prisma.stockMovement.findFirst({
      where: { refType: 'sale_void', refId: sale.body.id },
    });
    expect(compensating?.qtyDelta).toBe(20);
  });

  it('discounts are role-gated: cashier 422, pharmacist allowed (wireframe F8)', async () => {
    const fix = await seedCatalog();
    await createUser(`ph-${Date.now()}`, 'PHARMACIST');
    const username = (await prisma.user.findFirst({ where: { role: 'PHARMACIST' }, orderBy: { createdAt: 'desc' } }))!.username;
    const pharmacist = await authHeader(app, username);

    const discounted = (auth: Record<string, string>) =>
      request(app.getHttpServer())
        .post('/api/v1/sales')
        .set(auth)
        .send(
          saleBody(fix, {
            items: [
              { productId: fix.productId, productUnitId: fix.stripUnitId, quantity: 2, unitPrice: '5.00', discount: '1.00' },
            ],
            payments: [{ method: 'CASH', amount: '9.00' }],
          }),
        );

    const asCashier = await discounted(cashier);
    expect(asCashier.status).toBe(422);
    expect(asCashier.body.error.code).toBe('DISCOUNT_FORBIDDEN');

    const asPharmacist = await discounted(pharmacist);
    expect(asPharmacist.status).toBe(201);
    expect(asPharmacist.body.discountTotal).toBe('1');
  });

  it('VAT-inclusive math: VAT-applies lines carry the VAT portion in vat_total, total unchanged', async () => {
    const fix = await seedCatalog();
    await prisma.product.update({ where: { id: fix.productId }, data: { vatApplies: true } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(
        saleBody(fix, {
          items: [{ productId: fix.productId, quantity: 23, unitPrice: '0.50' }], // 11.50 gross
          payments: [{ method: 'MOMO', amount: '11.50', momoRef: 'MP123' }],
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.total).toBe('11.5');
    // 11.50 × 0.15/1.15 = 1.50
    expect(res.body.vatTotal).toBe('1.5');
  });
});
