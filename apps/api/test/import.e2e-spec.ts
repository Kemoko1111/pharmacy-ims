import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { authHeader, createTestApp, createUser, prisma, resetDb } from './helpers';

const QB_CSV = `Item Name,Item Number,Department,UPC,Price 1,Reorder Point,On-Hand Qty,Average Unit Cost
Paracetamol 500mg Tabs,1001,Medicines,6151100010999,0.50,200,350,0.22
Cough Syrup 100ml,1002,Medicines,6151100020999,15.00,10,25,9.50
Hand Sanitizer 250ml,1003,Household,,20.00,12,40,12.00
,1004,Medicines,,9.99,5,10,5.00
Bad Price Item,1005,Medicines,,not-a-price,5,10,5.00
`;

describe('QuickBooks CSV import (US-16)', () => {
  let app: INestApplication;
  let admin: Record<string, string>;
  let manager: Record<string, string>;

  beforeAll(async () => {
    await resetDb();
    await createUser('root', 'ADMIN');
    await createUser('boss', 'MANAGER');
    app = await createTestApp();
    admin = await authHeader(app, 'root');
    manager = await authHeader(app, 'boss');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('is Admin-only', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/products/import')
      .set(manager)
      .attach('file', Buffer.from(QB_CSV), 'items.csv');
    expect(res.status).toBe(403);
  });

  it('imports valid rows, maps QB columns, reports per-row errors, and creates categories', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/products/import?importStock=true')
      .set(admin)
      .attach('file', Buffer.from(QB_CSV), 'items.csv');

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(3);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(2); // missing name + bad price
    expect(res.body.errors.map((e: { row: number }) => e.row).sort()).toEqual([5, 6]);

    const product = await prisma.product.findFirst({
      where: { legacyItemNo: '1001' },
      include: { barcodes: true, category: true, batches: true },
    });
    expect(product?.name).toBe('Paracetamol 500mg Tabs');
    expect(product?.sellingPriceBase.toString()).toBe('0.5');
    expect(product?.reorderLevel).toBe(200);
    expect(product?.category.name).toBe('Medicines');
    expect(product?.barcodes[0]?.barcode).toBe('6151100010999');

    // stock landed as a flagged placeholder batch + OPENING ledger entry
    expect(product?.batches[0]?.batchNumber).toBe('QB-IMPORT');
    expect(product?.batches[0]?.qtyOnHand).toBe(350);
    const movement = await prisma.stockMovement.findFirst({
      where: { productId: product!.id, refType: 'qb_import' },
    });
    expect(movement?.type).toBe('OPENING');
    expect(movement?.qtyDelta).toBe(350);

    const review = await prisma.notification.findFirst({ where: { type: 'QB_IMPORT_REVIEW' } });
    expect(review).not.toBeNull();
  });

  it('is idempotent: re-importing the same file skips every existing item', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/products/import')
      .set(admin)
      .attach('file', Buffer.from(QB_CSV), 'items.csv');

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(0);
    expect(res.body.skipped).toBe(3);
  });

  it('rejects a CSV whose headers cannot be recognized', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/products/import')
      .set(admin)
      .attach('file', Buffer.from('Foo,Bar\n1,2\n'), 'items.csv');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CSV_HEADERS_UNRECOGNIZED');
  });
});
