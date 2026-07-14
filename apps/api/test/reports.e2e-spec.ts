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

describe('Reporting & health', () => {
  let app: INestApplication;
  let manager: Record<string, string>;
  let cashier: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await seedSettings();
    await createUser('boss', 'MANAGER');
    await createUser('akosua', 'CASHIER');
    app = await createTestApp();
    manager = await authHeader(app, 'boss');
    cashier = await authHeader(app, 'akosua');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /health is public and reports db ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('daily report aggregates the day: gross, receipts, byMethod, byCashier', async () => {
    const fix = await seedCatalog();
    await request(app.getHttpServer()).post('/api/v1/sales').set(cashier).send(saleBody(fix)).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(cashier)
      .send(
        saleBody(fix, {
          items: [{ productId: fix.productId, quantity: 10, unitPrice: '0.50' }],
          payments: [{ method: 'MOMO', amount: '5.00' }],
        }),
      )
      .expect(201);

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/daily?date=${today}`)
      .set(manager);
    expect(res.status).toBe(200);
    expect(res.body.receipts).toBe(2);
    expect(Number(res.body.gross)).toBeCloseTo(15);
    const methods = Object.fromEntries(
      res.body.byMethod.map((m: { method: string; amount: string }) => [m.method, Number(m.amount)]),
    );
    expect(methods.CASH).toBeCloseTo(10);
    expect(methods.MOMO).toBeCloseTo(5);
    expect(res.body.byCashier[0].receipts).toBe(2);
  });

  it('dashboard returns action-needed counts fed by the DDL views', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/reports/dashboard').set(manager);
    expect(res.status).toBe(200);
    expect(res.body.actionNeeded).toHaveProperty('lowStockCount');
    expect(res.body.actionNeeded).toHaveProperty('expiringCount');
    expect(Array.isArray(res.body.trend14d)).toBe(true);
    expect(res.body.today.receipts).toBeGreaterThanOrEqual(0);
  });

  it('cashier sees own-today sales only; manager sees all (api-schema.md)', async () => {
    const asCashier = await request(app.getHttpServer()).get('/api/v1/sales').set(cashier);
    expect(asCashier.status).toBe(200);
    // every row must belong to the cashier
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set(cashier);
    for (const sale of asCashier.body.data) {
      expect(sale.cashierId).toBe(me.body.id);
    }

    const asManager = await request(app.getHttpServer()).get('/api/v1/sales').set(manager);
    expect(asManager.status).toBe(200);
    expect(asManager.body.meta.total).toBeGreaterThanOrEqual(asCashier.body.meta.total);
  });
});
