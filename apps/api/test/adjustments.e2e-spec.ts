import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { JobsService } from '../src/modules/notifications/jobs.service';
import { authHeader, createTestApp, createUser, prisma, resetDb, seedCatalog } from './helpers';

describe('Adjustments, quarantine, scheduled sweeps (US-12, BR-05)', () => {
  let app: INestApplication;
  let pharmacist: Record<string, string>;
  let manager: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await prisma.setting.create({ data: { key: 'adjust_approval_threshold', value: 50 } });
    await createUser('adjoa', 'PHARMACIST');
    await createUser('boss', 'MANAGER');
    app = await createTestApp();
    pharmacist = await authHeader(app, 'adjoa');
    manager = await authHeader(app, 'boss');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('auto-approves small adjustments (≤ threshold) and posts the movement immediately', async () => {
    const fix = await seedCatalog();

    // −10 tablets @ 0.20 = GHS 2 value, well under the 50 threshold
    const res = await request(app.getHttpServer())
      .post('/api/v1/adjustments')
      .set(pharmacist)
      .send({ productId: fix.productId, batchId: fix.batchEarlyId, qtyDelta: -10, reason: 'DAMAGE', note: 'dropped strip' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('APPROVED');

    const batch = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(batch?.qtyOnHand).toBe(20);

    const movement = await prisma.stockMovement.findFirst({
      where: { refType: 'stock_adjustment', refId: res.body.id },
    });
    expect(movement?.qtyDelta).toBe(-10);
    expect(movement?.type).toBe('ADJUSTMENT');
  });

  it('queues big adjustments for the Manager; approval posts stock, rejection leaves it', async () => {
    const fix = await seedCatalog();

    // −100 tablets from LATE @0.22 = GHS 22... make it big: raise batch cost
    await prisma.batch.update({
      where: { id: fix.batchLateId },
      data: { unitCost: new Prisma.Decimal('2.00') },
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/adjustments')
      .set(pharmacist)
      .send({ productId: fix.productId, batchId: fix.batchLateId, qtyDelta: -50, reason: 'THEFT' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_APPROVAL'); // 50 × 2.00 = 100 > 50

    // pharmacist cannot decide
    const denied = await request(app.getHttpServer())
      .post(`/api/v1/adjustments/${res.body.id}/approve`)
      .set(pharmacist)
      .send({ decision: 'APPROVED' });
    expect(denied.status).toBe(403);

    // stock untouched while pending
    let batch = await prisma.batch.findUnique({ where: { id: fix.batchLateId } });
    expect(batch?.qtyOnHand).toBe(100);

    const approved = await request(app.getHttpServer())
      .post(`/api/v1/adjustments/${res.body.id}/approve`)
      .set(manager)
      .send({ decision: 'APPROVED', note: 'police report filed' });
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('APPROVED');

    batch = await prisma.batch.findUnique({ where: { id: fix.batchLateId } });
    expect(batch?.qtyOnHand).toBe(50);

    // double-decide is refused
    const again = await request(app.getHttpServer())
      .post(`/api/v1/adjustments/${res.body.id}/approve`)
      .set(manager)
      .send({ decision: 'REJECTED' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
  });

  it('quarantines expired batches in bulk and drafts approval-gated disposal adjustments (Screen 6)', async () => {
    const fix = await seedCatalog();
    const expiredBatchId = uuid();
    await prisma.batch.create({
      data: {
        id: expiredBatchId,
        productId: fix.productId,
        batchNumber: 'EXP-BULK',
        expiryDate: new Date(Date.now() - 86_400_000),
        qtyOnHand: 25,
        unitCost: new Prisma.Decimal('0.20'),
        status: 'ACTIVE',
      },
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/adjustments/quarantine-expired')
      .set(pharmacist);
    expect(res.status).toBe(201);
    expect(res.body.quarantined).toBeGreaterThanOrEqual(1);

    const batch = await prisma.batch.findUnique({ where: { id: expiredBatchId } });
    expect(batch?.status).toBe('QUARANTINED');
    expect(batch?.qtyOnHand).toBe(25); // stock not written off until approved

    const adj = await prisma.stockAdjustment.findFirst({
      where: { batchId: expiredBatchId, reason: 'EXPIRY_DISPOSAL' },
    });
    expect(adj?.status).toBe('PENDING_APPROVAL');
    expect(adj?.qtyDelta).toBe(-25);

    // manager approves → DISPOSAL movement + stock written off
    await request(app.getHttpServer())
      .post(`/api/v1/adjustments/${adj!.id}/approve`)
      .set(manager)
      .send({ decision: 'APPROVED' })
      .expect(201);
    const after = await prisma.batch.findUnique({ where: { id: expiredBatchId } });
    expect(after?.qtyOnHand).toBe(0);
    const movement = await prisma.stockMovement.findFirst({
      where: { refType: 'stock_adjustment', refId: adj!.id },
    });
    expect(movement?.type).toBe('DISPOSAL');
  });

  it('expiry sweep flags expired ACTIVE batches and creates notifications', async () => {
    const fix = await seedCatalog();
    const dying = uuid();
    await prisma.batch.create({
      data: {
        id: dying,
        productId: fix.productId,
        batchNumber: 'SWEEP-ME',
        expiryDate: new Date(Date.now() - 3600_000),
        qtyOnHand: 7,
        unitCost: new Prisma.Decimal('1.00'),
        status: 'ACTIVE',
      },
    });

    const jobs = app.get(JobsService);
    const result = await jobs.expirySweep();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const batch = await prisma.batch.findUnique({ where: { id: dying } });
    expect(batch?.status).toBe('EXPIRED');

    const notif = await prisma.notification.findFirst({
      where: { type: 'EXPIRED', payload: { path: ['batchId'], equals: dying } },
    });
    expect(notif).not.toBeNull();
  });

  it('low-stock scan notifies once per product (no spam on re-run)', async () => {
    const fix = await seedCatalog();
    await prisma.batch.updateMany({ where: { productId: fix.productId }, data: { qtyOnHand: 1 } });

    const jobs = app.get(JobsService);
    const first = await jobs.lowStockScan();
    expect(first.notified).toBeGreaterThanOrEqual(1);

    const second = await jobs.lowStockScan();
    expect(second.notified).toBe(0); // deduped while unseen

    // manager sees it and marks seen via the API
    const list = await request(app.getHttpServer())
      .get('/api/v1/notifications?unseen=true')
      .set(manager);
    expect(list.status).toBe(200);
    const lowStock = list.body.data.find(
      (n: { type: string; payload: { productId: string } }) =>
        n.type === 'LOW_STOCK' && n.payload.productId === fix.productId,
    );
    expect(lowStock).toBeDefined();

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${lowStock.id}/seen`)
      .set(manager)
      .expect(204);
  });
});
