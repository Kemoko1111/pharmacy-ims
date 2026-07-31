import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import {
  authHeader,
  createTestApp,
  createUser,
  prisma,
  resetDb,
  seedCatalog,
  seedSettings,
  testBranch,
  type CatalogFixture,
} from './helpers';

const base = '/api/v1';

/**
 * Stock transfers between branches (ADR-010, Phase 6).
 *
 * The property under test throughout is that a transfer is two one-sided
 * operations: the sender can only dispatch, the receiver can only receive, and
 * neither can act on the other's half. Stock must never be in both places at
 * once, nor in neither.
 */
describe('Stock transfers', () => {
  let app: INestApplication;
  let fix: CatalogFixture; // EARLY(30) + LATE(100) at Accra

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    await seedSettings();
    fix = await seedCatalog(testBranch.primaryId);
    await createUser('accra_mgr', 'MANAGER', testBranch.primaryId);
    await createUser('kumasi_mgr', 'MANAGER', testBranch.secondaryId);
  });

  const draft = async (qty = 10, batchId?: string) => {
    const res = await request(app.getHttpServer())
      .post(`${base}/transfers`)
      .set(await authHeader(app, 'accra_mgr'))
      .send({
        toBranchId: testBranch.secondaryId,
        items: [{ sourceBatchId: batchId ?? fix.batchEarlyId, qtyBase: qty }],
      });
    expect(res.status).toBe(201);
    return res.body as {
      id: string;
      transferNumber: string;
      status: string;
      items: { id: string; qtyBase: number; qtyReceived: number }[];
    };
  };

  const qtyOf = async (batchId: string) =>
    (await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).qtyOnHand;

  it('numbers the transfer with the sending branch code', async () => {
    const t = await draft();
    expect(t.transferNumber).toMatch(/^ACC-TRF-\d{4}-\d{4}$/);
    expect(t.status).toBe('DRAFT');
  });

  it('leaves stock on the shelf while the transfer is still a draft', async () => {
    await draft(10);
    expect(await qtyOf(fix.batchEarlyId)).toBe(30);
    const movements = await prisma.stockMovement.count({ where: { refType: 'stock_transfer' } });
    expect(movements).toBe(0);
  });

  it('refuses to draft more than the batch holds', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base}/transfers`)
      .set(await authHeader(app, 'accra_mgr'))
      .send({
        toBranchId: testBranch.secondaryId,
        items: [{ sourceBatchId: fix.batchEarlyId, qtyBase: 999 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('will not send stock the branch does not hold', async () => {
    // A batch that exists only at Kumasi is invisible to an Accra draft.
    const kumasiOnly = uuid();
    await prisma.batch.create({
      data: {
        id: kumasiOnly,
        branchId: testBranch.secondaryId,
        productId: fix.productId,
        batchNumber: 'KUM-ONLY',
        expiryDate: new Date(Date.now() + 90 * 86_400_000),
        qtyOnHand: 50,
        unitCost: new Prisma.Decimal('0.20'),
        status: 'ACTIVE',
      },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/transfers`)
      .set(await authHeader(app, 'accra_mgr'))
      .send({
        toBranchId: testBranch.secondaryId,
        items: [{ sourceBatchId: kumasiOnly, qtyBase: 5 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BATCH_UNKNOWN');
  });

  it('refuses a transfer to the branch it came from', async () => {
    const res = await request(app.getHttpServer())
      .post(`${base}/transfers`)
      .set(await authHeader(app, 'accra_mgr'))
      .send({
        toBranchId: testBranch.primaryId,
        items: [{ sourceBatchId: fix.batchEarlyId, qtyBase: 1 }],
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SAME_BRANCH');
  });

  describe('dispatch', () => {
    it('takes stock off the sending shelf and records TRANSFER_OUT', async () => {
      const t = await draft(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('IN_TRANSIT');
      expect(await qtyOf(fix.batchEarlyId)).toBe(20);

      const out = await prisma.stockMovement.findFirst({
        where: { refType: 'stock_transfer', refId: t.id, type: 'TRANSFER_OUT' },
      });
      expect(out?.qtyDelta).toBe(-10);
      expect(out?.branchId).toBe(testBranch.primaryId);

      // Nothing has landed at the destination yet.
      const atKumasi = await prisma.batch.count({ where: { branchId: testBranch.secondaryId } });
      expect(atKumasi).toBe(0);
    });

    it('cannot be done by the receiving branch', async () => {
      const t = await draft(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({});
      expect(res.status).toBe(404);
      expect(await qtyOf(fix.batchEarlyId)).toBe(30);
    });

    it('re-checks stock at dispatch, not just at draft', async () => {
      const t = await draft(30); // the whole batch
      // …then most of it is adjusted away before the goods actually leave.
      await prisma.batch.update({ where: { id: fix.batchEarlyId }, data: { qtyOnHand: 5 } });

      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(await qtyOf(fix.batchEarlyId)).toBe(5); // rolled back intact
    });

    it('shows the value as in transit only between dispatch and receipt', async () => {
      const t = await draft(10);

      const before = await request(app.getHttpServer())
        .get(`${base}/transfers/in-transit`)
        .set(await authHeader(app, 'accra_mgr'));
      expect(Number(before.body.totalValue)).toBe(0);

      await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});

      const during = await request(app.getHttpServer())
        .get(`${base}/transfers/in-transit`)
        .set(await authHeader(app, 'accra_mgr'));
      expect(Number(during.body.totalValue)).toBeCloseTo(2.0); // 10 × 0.20

      await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({});

      const after = await request(app.getHttpServer())
        .get(`${base}/transfers/in-transit`)
        .set(await authHeader(app, 'accra_mgr'));
      expect(Number(after.body.totalValue)).toBe(0);
    });
  });

  describe('receipt', () => {
    const dispatched = async (qty = 10) => {
      const t = await draft(qty);
      await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});
      return t;
    };

    it('creates the destination batch carrying batch identity and cost across', async () => {
      const t = await dispatched(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('RECEIVED');

      const landed = await prisma.batch.findFirstOrThrow({
        where: { branchId: testBranch.secondaryId, productId: fix.productId },
      });
      expect(landed.batchNumber).toBe('EARLY');
      expect(landed.qtyOnHand).toBe(10);
      expect(Number(landed.unitCost)).toBeCloseTo(0.2);

      const movIn = await prisma.stockMovement.findFirst({
        where: { refType: 'stock_transfer', refId: t.id, type: 'TRANSFER_IN' },
      });
      expect(movIn?.qtyDelta).toBe(10);
      expect(movIn?.branchId).toBe(testBranch.secondaryId);

      // Conservation: 30 at Accra became 20 there and 10 at Kumasi.
      expect(await qtyOf(fix.batchEarlyId)).toBe(20);
    });

    it('tops up an existing batch of the same identity rather than duplicating it', async () => {
      const existing = uuid();
      await prisma.batch.create({
        data: {
          id: existing,
          branchId: testBranch.secondaryId,
          productId: fix.productId,
          batchNumber: 'EARLY',
          expiryDate: (await prisma.batch.findUniqueOrThrow({ where: { id: fix.batchEarlyId } }))
            .expiryDate,
          qtyOnHand: 4,
          unitCost: new Prisma.Decimal('0.20'),
          status: 'ACTIVE',
        },
      });

      const t = await dispatched(10);
      await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({});

      const atKumasi = await prisma.batch.findMany({
        where: { branchId: testBranch.secondaryId, productId: fix.productId },
      });
      expect(atKumasi).toHaveLength(1);
      expect(atKumasi[0].id).toBe(existing);
      expect(atKumasi[0].qtyOnHand).toBe(14);
    });

    it('cannot be done by the sending branch', async () => {
      const t = await dispatched(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});
      expect(res.status).toBe(404);
      expect(await prisma.batch.count({ where: { branchId: testBranch.secondaryId } })).toBe(0);
    });

    it('keeps a short receipt visible and tells the sending branch', async () => {
      const t = await dispatched(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({ items: [{ itemId: t.items[0].id, qtyReceived: 7 }] });

      expect(res.status).toBe(200);
      expect(res.body.items[0].qtyBase).toBe(10);
      expect(res.body.items[0].qtyReceived).toBe(7);

      // Only what arrived is on the destination shelf — the missing 3 are not
      // quietly conjured into existence.
      const landed = await prisma.batch.findFirstOrThrow({
        where: { branchId: testBranch.secondaryId, productId: fix.productId },
      });
      expect(landed.qtyOnHand).toBe(7);

      const alert = await prisma.notification.findFirst({
        where: { type: 'TRANSFER_SHORT_RECEIPT', branchId: testBranch.primaryId },
      });
      expect(alert).not.toBeNull();
    });

    it('refuses to receive more than was sent', async () => {
      const t = await dispatched(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(await authHeader(app, 'kumasi_mgr'))
        .send({ items: [{ itemId: t.items[0].id, qtyReceived: 25 }] });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('RECEIVED_EXCEEDS_SENT');
    });

    it('cannot be received twice', async () => {
      const t = await dispatched(10);
      const headers = await authHeader(app, 'kumasi_mgr');
      await request(app.getHttpServer()).post(`${base}/transfers/${t.id}/receive`).set(headers).send({});
      const again = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/receive`)
        .set(headers)
        .send({});

      expect(again.status).toBe(422);
      expect(again.body.error.code).toBe('TRANSFER_NOT_IN_TRANSIT');

      const landed = await prisma.batch.findFirstOrThrow({
        where: { branchId: testBranch.secondaryId, productId: fix.productId },
      });
      expect(landed.qtyOnHand).toBe(10); // not 20
    });
  });

  describe('cancellation', () => {
    it('cancels a draft without moving stock', async () => {
      const t = await draft(10);
      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/cancel`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await qtyOf(fix.batchEarlyId)).toBe(30);
    });

    it('refuses once the goods are already moving', async () => {
      const t = await draft(10);
      await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/dispatch`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});

      const res = await request(app.getHttpServer())
        .post(`${base}/transfers/${t.id}/cancel`)
        .set(await authHeader(app, 'accra_mgr'))
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TRANSFER_NOT_DRAFT');
    });
  });

  describe('visibility', () => {
    it('shows each branch its own half and hides unrelated branches', async () => {
      const t = await draft(10);

      const accra = await request(app.getHttpServer())
        .get(`${base}/transfers`)
        .set(await authHeader(app, 'accra_mgr'));
      expect(accra.body.data.map((x: { id: string }) => x.id)).toContain(t.id);

      const kumasi = await request(app.getHttpServer())
        .get(`${base}/transfers`)
        .set(await authHeader(app, 'kumasi_mgr'));
      expect(kumasi.body.data.map((x: { id: string }) => x.id)).toContain(t.id);

      // A third branch is party to neither end.
      const other = await prisma.branch.create({
        data: { id: uuid(), code: 'TAM', name: 'Tamale' },
      });
      await createUser('tamale_mgr', 'MANAGER', other.id);
      const outsider = await request(app.getHttpServer())
        .get(`${base}/transfers`)
        .set(await authHeader(app, 'tamale_mgr'));
      expect(outsider.body.data).toHaveLength(0);
    });
  });
});
