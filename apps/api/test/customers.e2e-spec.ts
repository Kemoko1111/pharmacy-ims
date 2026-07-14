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

describe('Customers (US-15)', () => {
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

  it('customer records are Pharmacist/Manager only (Act 843 posture)', async () => {
    const denied = await request(app.getHttpServer()).get('/api/v1/customers').set(cashier);
    expect(denied.status).toBe(403);

    const deniedCreate = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set(cashier)
      .send({ fullName: 'Nope' });
    expect(deniedCreate.status).toBe(403);
  });

  it('CRUD + duplicate phone rejected + search by name/phone', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set(pharmacist)
      .send({ fullName: 'Ama Serwaa', phone: '0244000001', notes: 'hypertensive' });
    expect(created.status).toBe(201);

    const dupe = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set(pharmacist)
      .send({ fullName: 'Other Person', phone: '0244000001' });
    expect(dupe.status).toBe(409);

    for (const q of ['ama', '0244000001']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/customers?q=${q}`)
        .set(pharmacist);
      expect(res.body.data.some((c: { id: string }) => c.id === created.body.id)).toBe(true);
    }

    const updated = await request(app.getHttpServer())
      .patch(`/api/v1/customers/${created.body.id}`)
      .set(pharmacist)
      .send({ notes: 'hypertensive; amlodipine monthly' });
    expect(updated.status).toBe(200);
    expect(updated.body.notes).toContain('amlodipine');
  });

  it('purchase history lists the customer’s sales', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set(pharmacist)
      .send({ fullName: 'Kofi Boakye', phone: '0244000002' });

    const fix = await seedCatalog();
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set(pharmacist)
      .send({ ...saleBody(fix), customerId: customer.body.id });
    expect(sale.status).toBe(201);

    const history = await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.body.id}/history`)
      .set(pharmacist);
    expect(history.status).toBe(200);
    expect(history.body.meta.total).toBe(1);
    expect(history.body.data[0].receiptNumber).toBe(sale.body.receiptNumber);
    expect(history.body.data[0].items).toContain('Paracetamol');
  });
});
