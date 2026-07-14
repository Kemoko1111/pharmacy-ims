import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authHeader, createTestApp, createUser, prisma, resetDb, seedCatalog } from './helpers';

describe('Purchasing: PO → receiving (US-09, US-10, US-11)', () => {
  let app: INestApplication;
  let inventory: Record<string, string>;
  let manager: Record<string, string>;
  let supplierId: string;

  beforeAll(async () => {
    await resetDb();
    await createUser('kwame', 'INVENTORY_OFFICER');
    await createUser('boss', 'MANAGER');
    app = await createTestApp();
    inventory = await authHeader(app, 'kwame');
    manager = await authHeader(app, 'boss');

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set(inventory)
      .send({ name: 'Ernest Chemists', phone: '0302-660000' });
    expect(supplier.status).toBe(201);
    supplierId = supplier.body.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a PO (DRAFT), sends it, and receives it in two deliveries with correct batch + ledger + status', async () => {
    const fix = await seedCatalog();

    const po = await request(app.getHttpServer())
      .post('/api/v1/purchase-orders')
      .set(inventory)
      .send({
        supplierId,
        items: [{ productId: fix.productId, qtyBase: 100, unitCost: '0.25' }],
      });
    expect(po.status).toBe(201);
    expect(po.body.poNumber).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(po.body.status).toBe('DRAFT');

    const sent = await request(app.getHttpServer())
      .post(`/api/v1/purchase-orders/${po.body.id}/send`)
      .set(inventory);
    expect(sent.body.status).toBe('SENT');

    // First delivery: 60 of 100
    const grn1 = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send({
        poId: po.body.id,
        supplierId,
        items: [
          { productId: fix.productId, qtyBase: 60, unitCost: '0.25', batchNumber: 'NEW01', expiryDate: '2028-01-31' },
        ],
      });
    expect(grn1.status).toBe(201);
    expect(grn1.body.grnNumber).toMatch(/^GRN-\d{4}-\d{4}$/);

    const afterFirst = await request(app.getHttpServer())
      .get(`/api/v1/purchase-orders/${po.body.id}`)
      .set(inventory);
    expect(afterFirst.body.status).toBe('PARTIALLY_RECEIVED');
    expect(afterFirst.body.items[0].qtyReceived).toBe(60);

    const batch = await prisma.batch.findFirst({
      where: { productId: fix.productId, batchNumber: 'NEW01' },
    });
    expect(batch?.qtyOnHand).toBe(60);
    expect(batch?.status).toBe('ACTIVE');

    const movement = await prisma.stockMovement.findFirst({
      where: { refType: 'goods_receipt', refId: grn1.body.id },
    });
    expect(movement?.qtyDelta).toBe(60);
    expect(movement?.type).toBe('RECEIPT');

    // Second delivery completes the order
    await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send({
        poId: po.body.id,
        supplierId,
        items: [
          { productId: fix.productId, qtyBase: 40, unitCost: '0.25', batchNumber: 'NEW02', expiryDate: '2028-03-31' },
        ],
      })
      .expect(201);

    const done = await request(app.getHttpServer())
      .get(`/api/v1/purchase-orders/${po.body.id}`)
      .set(inventory);
    expect(done.body.status).toBe('RECEIVED');
  });

  it('blocks over-receipt without the Manager flag (422) and allows it with one (US-09 AC2)', async () => {
    const fix = await seedCatalog();

    const po = await request(app.getHttpServer())
      .post('/api/v1/purchase-orders')
      .set(inventory)
      .send({ supplierId, items: [{ productId: fix.productId, qtyBase: 10, unitCost: '0.20' }] });

    const over = {
      poId: po.body.id,
      supplierId,
      items: [
        { productId: fix.productId, qtyBase: 15, unitCost: '0.20', batchNumber: 'OVER1', expiryDate: '2028-06-30' },
      ],
    };

    const refused = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send(over);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('OVER_RECEIPT');

    // inventory officer cannot self-approve the override
    const notManager = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send({ ...over, allowOverReceipt: true });
    expect(notManager.status).toBe(403);

    const approved = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(manager)
      .send({ ...over, allowOverReceipt: true });
    expect(approved.status).toBe(201);
  });

  it('tops up an existing batch with weighted-average cost (ADR-004)', async () => {
    const fix = await seedCatalog();
    const early = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    const expiry = early!.expiryDate.toISOString().slice(0, 10);

    // EARLY: 30 @ 0.20 — receive 30 more @ 0.40 into the same batch/expiry
    const res = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send({
        supplierId,
        items: [
          { productId: fix.productId, qtyBase: 30, unitCost: '0.40', batchNumber: 'EARLY', expiryDate: expiry },
        ],
      });
    expect(res.status).toBe(201);

    const topped = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(topped?.qtyOnHand).toBe(60);
    expect(Number(topped?.unitCost)).toBeCloseTo(0.3, 4); // (30×0.20 + 30×0.40)/60
  });

  it('rejects receiving stock that is already expired', async () => {
    const fix = await seedCatalog();
    const res = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send({
        supplierId,
        items: [
          { productId: fix.productId, qtyBase: 10, unitCost: '0.20', batchNumber: 'OLD', expiryDate: '2020-01-01' },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EXPIRED_ON_ARRIVAL');
  });

  it('drafts a PO from the low-stock list (US-10 AC2)', async () => {
    const fix = await seedCatalog();
    // drain stock to trip the reorder level (reorderLevel 20, on hand 130)
    await prisma.batch.updateMany({
      where: { productId: fix.productId },
      data: { qtyOnHand: 5 },
    });
    await prisma.batch.update({ where: { id: fix.batchLateId }, data: { qtyOnHand: 0 } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/purchase-orders/from-suggestions')
      .set(inventory)
      .send({ supplierId, productIds: [fix.productId] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    const line = res.body.items.find((i: { productId: string }) => i.productId === fix.productId);
    expect(line).toBeDefined();
    expect(line.qtyBase).toBeGreaterThanOrEqual(20); // at least back to reorder level
  });
});
