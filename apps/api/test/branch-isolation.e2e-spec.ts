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
  saleBody,
  seedCatalog,
  seedSettings,
  testBranch,
  type CatalogFixture,
} from './helpers';

/**
 * Cross-branch isolation (ADR-010).
 *
 * The branch-scope Prisma extension covers ORM calls, but raw SQL — the FEFO
 * allocator above all — is invisible to it. These are the tests that would
 * actually catch the failure that matters: one branch reading, selling, or
 * voiding another branch's stock. Every assertion here is a negative one.
 */
describe('Branch isolation', () => {
  let app: INestApplication;
  let fix: CatalogFixture;
  /** The same product, stocked at Kumasi as well as Accra. */
  let kumasiBatchId: string;

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
    fix = await seedCatalog(); // batches EARLY(30) + LATE(100) at Accra

    // Same product, separate stock at Kumasi — including a batch number that
    // also exists at Accra, which the old global unique constraint forbade.
    kumasiBatchId = uuid();
    await prisma.batch.create({
      data: {
        id: kumasiBatchId,
        branchId: testBranch.secondaryId,
        productId: fix.productId,
        batchNumber: 'EARLY', // deliberately duplicated across branches
        expiryDate: new Date(Date.now() + 60 * 86_400_000),
        qtyOnHand: 7,
        unitCost: new Prisma.Decimal('0.20'),
        status: 'ACTIVE',
      },
    });

    await createUser('accra_cashier', 'CASHIER', testBranch.primaryId);
    await createUser('accra_manager', 'MANAGER', testBranch.primaryId);
    await createUser('kumasi_cashier', 'CASHIER', testBranch.secondaryId);
    await createUser('kumasi_manager', 'MANAGER', testBranch.secondaryId);
  });

  it('lets the same batch number exist at two branches', async () => {
    const both = await prisma.batch.findMany({
      where: { productId: fix.productId, batchNumber: 'EARLY' },
    });
    expect(both).toHaveLength(2);
    expect(new Set(both.map((b) => b.branchId))).toEqual(
      new Set([testBranch.primaryId, testBranch.secondaryId]),
    );
  });

  it('will not let a till sell stock held at another branch', async () => {
    // Kumasi holds 7. Asking for 20 must fail rather than reach into Accra's 130.
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(await authHeader(app, 'kumasi_cashier'))
      .send(saleBody(fix, { items: [{ productId: fix.productId, quantity: 20, unitPrice: '0.50' }], payments: [{ method: 'CASH', amount: '10.00' }] }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');

    // and Accra's stock is untouched
    const accra = await prisma.batch.findMany({
      where: { branchId: testBranch.primaryId, productId: fix.productId },
    });
    expect(accra.reduce((s, b) => s + b.qtyOnHand, 0)).toBe(130);
  });

  it('allocates FEFO only within the selling branch', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(await authHeader(app, 'kumasi_cashier'))
      .send(saleBody(fix, { items: [{ productId: fix.productId, quantity: 5, unitPrice: '0.50' }], payments: [{ method: 'CASH', amount: '2.50' }] }));

    expect(res.status).toBe(201);

    const kumasi = await prisma.batch.findUniqueOrThrow({ where: { id: kumasiBatchId } });
    expect(kumasi.qtyOnHand).toBe(2);

    // Accra's earliest-expiry batch is the global FEFO winner but the wrong
    // branch — it must not have been touched.
    const accraEarly = await prisma.batch.findUniqueOrThrow({ where: { id: fix.batchEarlyId } });
    expect(accraEarly.qtyOnHand).toBe(30);
  });

  it('stamps the branch code on receipt numbers', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(await authHeader(app, 'kumasi_cashier'))
      .send(saleBody(fix, { items: [{ productId: fix.productId, quantity: 1, unitPrice: '0.50' }], payments: [{ method: 'CASH', amount: '0.50' }] }));

    expect(res.status).toBe(201);
    expect(res.body.receiptNumber).toMatch(/^KUM-RCP-\d{4}-\d{6}$/);
  });

  it('hides another branch sale from both the list and the detail route', async () => {
    const made = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(await authHeader(app, 'kumasi_cashier'))
      .send(saleBody(fix, { items: [{ productId: fix.productId, quantity: 1, unitPrice: '0.50' }], payments: [{ method: 'CASH', amount: '0.50' }] }));
    expect(made.status).toBe(201);
    const kumasiSaleId = made.body.id;

    const accraHeaders = await authHeader(app, 'accra_manager');

    const list = await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set(accraHeaders);
    expect(list.status).toBe(200);
    expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(kumasiSaleId);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/sales/${kumasiSaleId}`)
      .set(accraHeaders);
    expect(detail.status).toBe(404);
  });

  it('will not let a manager void another branch sale', async () => {
    const made = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(await authHeader(app, 'kumasi_cashier'))
      .send(saleBody(fix, { items: [{ productId: fix.productId, quantity: 1, unitPrice: '0.50' }], payments: [{ method: 'CASH', amount: '0.50' }] }));
    const kumasiSaleId = made.body.id;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/sales/${kumasiSaleId}/void`)
      .set(await authHeader(app, 'accra_manager'))
      .send({ reason: 'should not be possible' });

    expect(res.status).toBe(404);

    const still = await prisma.sale.findUniqueOrThrow({ where: { id: kumasiSaleId } });
    expect(still.status).toBe('COMPLETED');
  });

  it('scopes batches, movements and stock levels to the active branch', async () => {
    const kumasiHeaders = await authHeader(app, 'kumasi_manager');

    const batches = await request(app.getHttpServer())
      .get('/api/v1/inventory/batches')
      .set(kumasiHeaders);
    expect(batches.status).toBe(200);
    expect(batches.body.data.map((b: { id: string }) => b.id)).toEqual([kumasiBatchId]);

    const stock = await request(app.getHttpServer())
      .get('/api/v1/inventory/stock')
      .set(kumasiHeaders);
    expect(stock.status).toBe(200);
    const row = stock.body.find((r: { productId: string }) => r.productId === fix.productId);
    expect(row.qtyBase).toBe(7); // Kumasi's 7, not the 137 held across both
  });

  it('gives the offline snapshot only the active branch stock', async () => {
    const snap = await request(app.getHttpServer())
      .get('/api/v1/catalog/snapshot')
      .set(await authHeader(app, 'kumasi_cashier'));

    expect(snap.status).toBe(200);
    const product = snap.body.products.find((p: { id: string }) => p.id === fix.productId);
    expect(product.qtyOnHand).toBe(7);
  });

  describe('switching branch', () => {
    it('refuses a branch the user is not assigned to', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-branch')
        .set(await authHeader(app, 'accra_cashier'))
        .send({ branchId: testBranch.secondaryId });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('BRANCH_FORBIDDEN');
    });

    it('refuses consolidated mode to anyone below ADMIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-branch')
        .set(await authHeader(app, 'accra_manager'))
        .send({ branchId: null });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('CONSOLIDATED_FORBIDDEN');
    });

    it('moves an admin between branches and the reads follow', async () => {
      await prisma.userBranch.deleteMany({ where: {} });
      await createUser('owner', 'ADMIN', testBranch.primaryId);

      const asAccra = await authHeader(app, 'owner');
      const accraBatches = await request(app.getHttpServer())
        .get('/api/v1/inventory/batches')
        .set(asAccra);
      expect(accraBatches.body.data).toHaveLength(2); // EARLY + LATE

      const switched = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-branch')
        .set(asAccra)
        .send({ branchId: testBranch.secondaryId });
      expect(switched.status).toBe(200);
      expect(switched.body.activeBranch.code).toBe('KUM');

      const kumasiBatches = await request(app.getHttpServer())
        .get('/api/v1/inventory/batches')
        .set({ Authorization: `Bearer ${switched.body.accessToken}` });
      expect(kumasiBatches.body.data.map((b: { id: string }) => b.id)).toEqual([kumasiBatchId]);
    });
  });
});
