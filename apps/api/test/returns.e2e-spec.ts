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

describe('Returns (US-14)', () => {
  let app: INestApplication;
  let cashier: Record<string, string>;
  let pharmacist: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await seedSettings();
    await createUser('akosua', 'CASHIER');
    await createUser('adjoa', 'PHARMACIST');
    app = await createTestApp();
    cashier = await authHeader(app, 'akosua');
    pharmacist = await authHeader(app, 'adjoa');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function makeSale(fix: Awaited<ReturnType<typeof seedCatalog>>) {
    const res = await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(saleBody(fix));
    expect(res.status).toBe(201);
    return res.body as { id: string; items: { id: string; qtyBase: number; batchNumber: string }[] };
  }

  it('cashiers cannot post returns — approval is Pharmacist/Manager (AC2)', async () => {
    const fix = await seedCatalog();
    const sale = await makeSale(fix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set(cashier)
      .send({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0].id, qtyBase: 5, restock: true }],
        reason: 'wrong item',
      });
    expect(res.status).toBe(403);
  });

  it('partial return restocks the exact batch and pro-rates the refund', async () => {
    const fix = await seedCatalog();
    const sale = await makeSale(fix); // 2 strips = 20 tablets @ 5.00/strip = 10.00
    const before = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set(pharmacist)
      .send({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0].id, qtyBase: 10, restock: true }], // half of it
        reason: 'customer bought too many',
      });
    expect(res.status).toBe(201);
    expect(res.body.refundTotal).toBe('5'); // half of GHS 10

    const after = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(after!.qtyOnHand - before!.qtyOnHand).toBe(10);

    const movement = await prisma.stockMovement.findFirst({
      where: { refType: 'sale_return', refId: res.body.id },
    });
    expect(movement?.type).toBe('RETURN_IN');
    expect(movement?.qtyDelta).toBe(10);
  });

  it('restock=false refunds without touching stock; over-return is refused', async () => {
    const fix = await seedCatalog();
    const sale = await makeSale(fix);
    const before = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });

    const damaged = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set(pharmacist)
      .send({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0].id, qtyBase: 5, restock: false }],
        reason: 'blister damaged',
      });
    expect(damaged.status).toBe(201);

    const after = await prisma.batch.findUnique({ where: { id: fix.batchEarlyId } });
    expect(after!.qtyOnHand).toBe(before!.qtyOnHand); // nothing back on the shelf

    // 5 already returned; 20 sold → returning 16 more exceeds the line
    const over = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set(pharmacist)
      .send({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0].id, qtyBase: 16, restock: true }],
        reason: 'trying too much',
      });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RETURN_EXCEEDS_SOLD');
  });
});
