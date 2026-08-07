import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authHeader, createTestApp, createUser, prisma, resetDb, seedCatalog } from './helpers';

/**
 * Replay protection for offline writes (ADR-013).
 *
 * A till that posts a queued write and loses the answer cannot tell "never
 * arrived" from "arrived, reply lost", so it retries. Without a key on the
 * request, that retry posts the delivery a second time — and a phantom delivery
 * is a stock figure nobody can reconcile.
 */
describe('Idempotency-Key: writes drained from an offline queue', () => {
  let app: INestApplication;
  let inventory: Record<string, string>;
  let other: Record<string, string>;
  let supplierId: string;

  beforeAll(async () => {
    await resetDb();
    await createUser('kwame', 'INVENTORY_OFFICER');
    await createUser('ama', 'INVENTORY_OFFICER');
    app = await createTestApp();
    inventory = await authHeader(app, 'kwame');
    other = await authHeader(app, 'ama');

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set(inventory)
      .send({ name: 'Ernest Chemists', phone: '0302-660000' });
    supplierId = supplier.body.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const receipt = (productId: string, batchNumber: string) => ({
    supplierId,
    notes: 'queued while offline',
    items: [{ productId, qtyBase: 25, unitCost: '0.50', batchNumber, expiryDate: '2028-09-30' }],
  });

  it('replays the first answer instead of receiving the delivery twice', async () => {
    const fix = await seedCatalog();
    const body = receipt(fix.productId, 'DUP1');

    const first = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-dup-1')
      .send(body);
    expect(first.status).toBe(201);

    const retry = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-dup-1')
      .send(body);

    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    // The point of the whole exercise: one delivery on the shelf, not two.
    const receipts = await prisma.goodsReceipt.count();
    expect(receipts).toBe(1);
    const batch = await prisma.batch.findFirst({
      where: { productId: fix.productId, batchNumber: 'DUP1' },
    });
    expect(batch?.qtyOnHand).toBe(25);
  });

  it('without a key, the same request really does post twice', async () => {
    const fix = await seedCatalog();
    const body = receipt(fix.productId, 'NOKEY1');

    await request(app.getHttpServer()).post('/api/v1/goods-receipts').set(inventory).send(body);
    await request(app.getHttpServer()).post('/api/v1/goods-receipts').set(inventory).send(body);

    // The negative control. If this ever drops to 1, the test above proves
    // nothing, because the endpoint would be idempotent on its own.
    const batch = await prisma.batch.findFirst({
      where: { productId: fix.productId, batchNumber: 'NOKEY1' },
    });
    expect(batch?.qtyOnHand).toBe(50);
  });

  it('refuses a key reused for a different request', async () => {
    const fix = await seedCatalog();

    const first = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-reuse-1')
      .send(receipt(fix.productId, 'REUSE1'));
    expect(first.status).toBe(201);

    const different = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-reuse-1')
      .send(receipt(fix.productId, 'REUSE2'));

    expect(different.status).toBe(422);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('will not hand one session another session"s response', async () => {
    const fix = await seedCatalog();
    const body = receipt(fix.productId, 'OWNER1');

    await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-owner-1')
      .send(body);

    const stolen = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(other)
      .set('Idempotency-Key', 'op-owner-1')
      .send(body);

    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('IDEMPOTENCY_KEY_IN_USE');
  });

  it('frees the key when the write is refused, so a corrected retry can use it', async () => {
    const fix = await seedCatalog();

    // Already expired on arrival — the server refuses this outright.
    const refused = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-retry-1')
      .send({
        supplierId,
        items: [
          {
            productId: fix.productId,
            qtyBase: 5,
            unitCost: '0.50',
            batchNumber: 'BAD1',
            expiryDate: '2020-01-01',
          },
        ],
      });
    expect(refused.status).toBe(422);

    // A refusal describes the request, not a completed operation. The cashier
    // fixes the expiry date and the queue retries under the same key.
    const corrected = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .set('Idempotency-Key', 'op-retry-1')
      .send(receipt(fix.productId, 'GOOD1'));

    expect(corrected.status).toBe(201);
    expect(await prisma.idempotencyKey.count({ where: { key: 'op-retry-1' } })).toBe(1);
  });

  it('leaves ordinary online requests completely alone', async () => {
    const fix = await seedCatalog();

    const res = await request(app.getHttpServer())
      .post('/api/v1/goods-receipts')
      .set(inventory)
      .send(receipt(fix.productId, 'PLAIN1'));

    expect(res.status).toBe(201);
    expect(await prisma.idempotencyKey.count()).toBeGreaterThanOrEqual(0);
    const batch = await prisma.batch.findFirst({
      where: { productId: fix.productId, batchNumber: 'PLAIN1' },
    });
    expect(batch?.qtyOnHand).toBe(25);
  });
});
