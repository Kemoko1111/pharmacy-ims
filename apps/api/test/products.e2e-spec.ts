import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v7 as uuid } from 'uuid';
import { authHeader, createTestApp, createUser, prisma, resetDb } from './helpers';

describe('Catalog / products (US-03, US-04)', () => {
  let app: INestApplication;
  let inventory: Record<string, string>;
  let manager: Record<string, string>;
  let cashier: Record<string, string>;
  let categoryId: string;

  beforeAll(async () => {
    await resetDb();
    await createUser('kwame', 'INVENTORY_OFFICER');
    await createUser('boss', 'MANAGER');
    await createUser('till', 'CASHIER');
    app = await createTestApp();
    inventory = await authHeader(app, 'kwame');
    manager = await authHeader(app, 'boss');
    cashier = await authHeader(app, 'till');

    categoryId = uuid();
    await prisma.category.create({ data: { id: categoryId, name: 'Medicines' } });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const productBody = (name: string, barcode: string) => ({
    name,
    genericName: 'Paracetamol',
    strength: '500 mg',
    form: 'TABLET',
    categoryId,
    baseUnit: 'tablet',
    sellingPriceBase: '0.50',
    reorderLevel: 10,
    vatApplies: false,
    prescriptionOnly: false,
    units: [{ unitName: 'strip', factorToBase: 10, sellingPrice: '5.00' }],
    barcodes: [barcode],
  });

  it('creates a product with units + barcodes and reads it back', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send(productBody('Paracetamol 500mg', '6151100010001'));
    expect(res.status).toBe(201);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.barcodes).toHaveLength(1);

    const get = await request(app.getHttpServer())
      .get(`/api/v1/products/${res.body.id}`)
      .set(cashier);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('Paracetamol 500mg');
  });

  it('rejects a duplicate barcode with 409 (US-03 AC2)', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send(productBody('Product A', 'DUPE-CODE'));
    expect(first.status).toBe(201);

    const dupe = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send(productBody('Product B', 'DUPE-CODE'));
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('DUPLICATE');
  });

  it('RBAC: cashier cannot create products (403); price change is Manager-only', async () => {
    const denied = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(cashier)
      .send(productBody('Nope', 'NO-CODE'));
    expect(denied.status).toBe(403);

    const created = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send(productBody('Priceable', 'PRICE-CODE'));

    // Inventory officer may edit fields but NOT price (BR-03)
    const priceByInventory = await request(app.getHttpServer())
      .patch(`/api/v1/products/${created.body.id}`)
      .set(inventory)
      .send({ sellingPriceBase: '0.60' });
    expect(priceByInventory.status).toBe(422);
    expect(priceByInventory.body.error.code).toBe('PRICE_CHANGE_FORBIDDEN');

    const priceByManager = await request(app.getHttpServer())
      .patch(`/api/v1/products/${created.body.id}`)
      .set(manager)
      .send({ sellingPriceBase: '0.60' });
    expect(priceByManager.status).toBe(200);

    const history = await prisma.priceHistory.findFirst({
      where: { productId: created.body.id },
    });
    expect(history?.newPrice.toString()).toBe('0.6');
  });

  it('search finds by name, generic and barcode; soft delete hides the product', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send({ ...productBody('Findable Syrup', 'FIND-CODE'), genericName: 'Uniquegeneric' });
    expect(created.status).toBe(201);

    for (const q of ['Findable', 'Uniquegeneric', 'FIND-CODE']) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/products?q=${encodeURIComponent(q)}`)
        .set(cashier);
      expect(res.status).toBe(200);
      expect(res.body.data.some((p: { id: string }) => p.id === created.body.id)).toBe(true);
    }

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/products/${created.body.id}`)
      .set(manager);
    expect(del.status).toBe(204);

    const gone = await request(app.getHttpServer())
      .get(`/api/v1/products/${created.body.id}`)
      .set(cashier);
    expect(gone.status).toBe(404);
  });

  it('barcode lookup resolves unit-level barcodes (US-06 AC1)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set(inventory)
      .send(productBody('Scanned Product', 'BASE-SCAN'));
    const unitId = created.body.units[0].id;

    await request(app.getHttpServer())
      .post(`/api/v1/products/${created.body.id}/barcodes`)
      .set(inventory)
      .send({ barcode: 'STRIP-SCAN', productUnitId: unitId })
      .expect(201);

    const hit = await request(app.getHttpServer()).get('/api/v1/barcodes/STRIP-SCAN').set(cashier);
    expect(hit.status).toBe(200);
    expect(hit.body.product.id).toBe(created.body.id);
    expect(hit.body.unit.id).toBe(unitId);

    const miss = await request(app.getHttpServer()).get('/api/v1/barcodes/UNKNOWN').set(cashier);
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('BARCODE_UNKNOWN');
  });
});
