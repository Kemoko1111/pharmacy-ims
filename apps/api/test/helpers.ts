import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, UserRole, Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { v7 as uuid } from 'uuid';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';

export const prisma = new PrismaClient();

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

/**
 * The two branches every test runs against (ADR-010). Mutated by `resetDb`, so
 * importing modules see the current ids. A second branch exists specifically so
 * isolation can be asserted rather than assumed.
 */
export const testBranch = {
  primaryId: '',
  secondaryId: '',
  primaryCode: 'ACC',
  secondaryCode: 'KUM',
};

/** Truncate all app tables (keeps _prisma_migrations), reset sequences, re-create branches. */
export async function resetDb() {
  const tables = [
    'audit_logs',
    'notifications',
    'sale_return_items',
    'sale_returns',
    'payments',
    'sale_items',
    'sales',
    'stock_movements',
    'stock_adjustments',
    'goods_receipt_items',
    'goods_receipts',
    'purchase_order_items',
    'purchase_orders',
    'batches',
    'price_history',
    'product_barcodes',
    'product_units',
    'branch_product_settings',
    'products',
    'categories',
    'customers',
    'suppliers',
    'refresh_tokens',
    'user_branches',
    'users',
    'branches',
    'settings',
  ];
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  for (const seq of ['receipt_number_seq', 'po_number_seq', 'grn_number_seq']) {
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
  }

  testBranch.primaryId = uuid();
  testBranch.secondaryId = uuid();
  await prisma.branch.createMany({
    data: [
      { id: testBranch.primaryId, code: testBranch.primaryCode, name: 'Accra Main' },
      { id: testBranch.secondaryId, code: testBranch.secondaryCode, name: 'Kumasi Branch' },
    ],
  });
}

const PASSWORD = 'Password1';

export async function createUser(
  username: string,
  role: UserRole,
  branchId: string = testBranch.primaryId,
) {
  const user = await prisma.user.create({
    data: {
      id: uuid(),
      username,
      fullName: `Test ${role}`,
      role,
      passwordHash: await hash(PASSWORD),
    },
  });
  // Login refuses an account with no branch, so every test user gets one.
  await prisma.userBranch.create({
    data: { userId: user.id, branchId, isDefault: true },
  });
  return user;
}

export async function login(app: INestApplication, username: string, password = PASSWORD) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ username, password });
  return res;
}

export async function authHeader(app: INestApplication, username: string) {
  const res = await login(app, username);
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

export async function seedSettings() {
  await prisma.setting.createMany({
    data: [
      { key: 'vat_rate', value: 0.15 },
      { key: 'receipt_header', value: { line1: 'Test Pharmacy' } },
    ],
    skipDuplicates: true,
  });
}

export interface CatalogFixture {
  categoryId: string;
  productId: string;
  stripUnitId: string;
  batchEarlyId: string;
  batchLateId: string;
}

/**
 * Paracetamol with two ACTIVE batches: early expiry (qty 30) and late expiry
 * (qty 100) — enough structure to exercise FEFO splits and depletion.
 */
export async function seedCatalog(branchId: string = testBranch.primaryId): Promise<CatalogFixture> {
  const categoryId = uuid();
  await prisma.category.create({ data: { id: categoryId, name: `Medicines-${categoryId.slice(-12)}` } });

  const productId = uuid();
  await prisma.product.create({
    data: {
      id: productId,
      name: 'Paracetamol 500mg Tablets',
      genericName: 'Paracetamol',
      form: 'TABLET',
      categoryId,
      baseUnit: 'tablet',
      sellingPriceBase: new Prisma.Decimal('0.50'),
      reorderLevel: 20,
    },
  });

  const stripUnitId = uuid();
  await prisma.productUnit.create({
    data: {
      id: stripUnitId,
      productId,
      unitName: 'strip',
      factorToBase: 10,
      sellingPrice: new Prisma.Decimal('5.00'),
    },
  });

  await prisma.productBarcode.create({
    data: { id: uuid(), productId, barcode: `BC-${productId.slice(-12)}` },
  });

  const early = new Date();
  early.setDate(early.getDate() + 60);
  const late = new Date();
  late.setDate(late.getDate() + 365);

  const batchEarlyId = uuid();
  const batchLateId = uuid();
  await prisma.batch.createMany({
    data: [
      {
        id: batchEarlyId,
        branchId,
        productId,
        batchNumber: 'EARLY',
        expiryDate: early,
        qtyOnHand: 30,
        unitCost: new Prisma.Decimal('0.20'),
        status: 'ACTIVE',
      },
      {
        id: batchLateId,
        branchId,
        productId,
        batchNumber: 'LATE',
        expiryDate: late,
        qtyOnHand: 100,
        unitCost: new Prisma.Decimal('0.22'),
        status: 'ACTIVE',
      },
    ],
  });

  return { categoryId, productId, stripUnitId, batchEarlyId, batchLateId };
}

export function saleBody(fix: CatalogFixture, overrides: Record<string, unknown> = {}) {
  return {
    clientSaleId: uuid(),
    soldAt: new Date().toISOString(),
    items: [
      { productId: fix.productId, productUnitId: fix.stripUnitId, quantity: 2, unitPrice: '5.00' },
    ],
    payments: [{ method: 'CASH', amount: '10.00', tendered: '20.00' }],
    ...overrides,
  };
}
