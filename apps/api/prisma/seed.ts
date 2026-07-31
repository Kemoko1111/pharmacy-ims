/**
 * Dev/demo seed — realistic Ghana pharmacy data, NO client data (MoU §4 / R9).
 * Idempotent: wipes and re-creates. Run: pnpm db:seed
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { v7 as uuid } from 'uuid';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'ChangeMe123!';

function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

interface BatchSpec {
  batchNumber: string;
  expiryInDays: number;
  qty: number; // base units
  unitCost: string;
}

interface UnitSpec {
  unitName: string;
  factorToBase: number;
  sellingPrice: string;
  barcode?: string;
}

interface ProductSpec {
  name: string;
  genericName?: string;
  strength?: string;
  form:
    | 'TABLET' | 'CAPSULE' | 'SYRUP' | 'SUSPENSION' | 'INJECTION' | 'CREAM'
    | 'OINTMENT' | 'DROPS' | 'INHALER' | 'SUPPOSITORY' | 'CONSUMABLE' | 'OTHER';
  category: string;
  baseUnit: string;
  sellingPriceBase: string;
  reorderLevel: number;
  vatApplies?: boolean;
  prescriptionOnly?: boolean;
  barcode?: string; // base-unit barcode
  units?: UnitSpec[];
  batches: BatchSpec[];
}

const PRODUCTS: ProductSpec[] = [
  {
    name: 'Paracetamol 500mg Tablets (M&G)',
    genericName: 'Paracetamol',
    strength: '500 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.50',
    reorderLevel: 200,
    barcode: '6151100010017',
    units: [
      { unitName: 'strip', factorToBase: 10, sellingPrice: '5.00', barcode: '6151100010024' },
      { unitName: 'box', factorToBase: 100, sellingPrice: '45.00', barcode: '6151100010031' },
    ],
    batches: [
      { batchNumber: 'PCM2401', expiryInDays: 240, qty: 420, unitCost: '0.22' },
      { batchNumber: 'PCM2407', expiryInDays: 420, qty: 600, unitCost: '0.24' },
    ],
  },
  {
    name: 'Paracetamol Syrup 125mg/5ml 100ml (Ernest)',
    genericName: 'Paracetamol',
    strength: '125 mg/5 ml',
    form: 'SYRUP',
    category: 'Medicines',
    baseUnit: 'bottle',
    sellingPriceBase: '12.00',
    reorderLevel: 10,
    barcode: '6151100020016',
    batches: [{ batchNumber: 'PS2403', expiryInDays: 300, qty: 8, unitCost: '7.50' }],
  },
  {
    name: 'Para-Extra (Paracetamol + Caffeine)',
    genericName: 'Paracetamol + Caffeine',
    strength: '500 mg + 65 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.80',
    reorderLevel: 100,
    units: [{ unitName: 'pack', factorToBase: 20, sellingPrice: '15.00', barcode: '6151100030015' }],
    batches: [{ batchNumber: 'PE2402', expiryInDays: 500, qty: 60, unitCost: '0.38' }], // low stock
  },
  {
    name: 'Amoxicillin 250mg Capsules (Danadams)',
    genericName: 'Amoxicillin',
    strength: '250 mg',
    form: 'CAPSULE',
    category: 'Medicines',
    baseUnit: 'capsule',
    sellingPriceBase: '0.90',
    reorderLevel: 150,
    prescriptionOnly: true,
    barcode: '6151100040014',
    units: [{ unitName: 'bottle', factorToBase: 20, sellingPrice: '18.00', barcode: '6151100040021' }],
    batches: [
      { batchNumber: 'AMX2311', expiryInDays: 60, qty: 200, unitCost: '0.40' }, // expiring ≤90d
      { batchNumber: 'AMX2405', expiryInDays: 350, qty: 400, unitCost: '0.42' },
    ],
  },
  {
    name: 'Amoxicillin+Clav 625mg (Augmentin generic)',
    genericName: 'Co-amoxiclav',
    strength: '500/125 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '3.50',
    reorderLevel: 50,
    prescriptionOnly: true,
    batches: [{ batchNumber: 'ACV2404', expiryInDays: 400, qty: 140, unitCost: '2.10' }],
  },
  {
    name: 'ORS Sachets (WHO formula)',
    genericName: 'Oral Rehydration Salts',
    form: 'CONSUMABLE',
    category: 'Medicines',
    baseUnit: 'sachet',
    sellingPriceBase: '2.50',
    reorderLevel: 50,
    barcode: '6151100050013',
    units: [{ unitName: 'box', factorToBase: 25, sellingPrice: '55.00' }],
    batches: [{ batchNumber: 'ORS2406', expiryInDays: 700, qty: 180, unitCost: '1.30' }],
  },
  {
    name: 'Artemether-Lumefantrine 20/120 (Coartem)',
    genericName: 'Artemether + Lumefantrine',
    strength: '20/120 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '1.80',
    reorderLevel: 120,
    barcode: '6151100060012',
    units: [{ unitName: 'pack (24)', factorToBase: 24, sellingPrice: '40.00', barcode: '6151100060029' }],
    batches: [
      { batchNumber: 'ALU2312', expiryInDays: -15, qty: 48, unitCost: '1.05' }, // EXPIRED — quarantine demo
      { batchNumber: 'ALU2408', expiryInDays: 380, qty: 240, unitCost: '1.10' },
    ],
  },
  {
    name: 'Metformin 500mg Tablets',
    genericName: 'Metformin HCl',
    strength: '500 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.45',
    reorderLevel: 200,
    prescriptionOnly: true,
    batches: [{ batchNumber: 'MET2405', expiryInDays: 450, qty: 500, unitCost: '0.20' }],
  },
  {
    name: 'Amlodipine 5mg Tablets',
    genericName: 'Amlodipine',
    strength: '5 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.60',
    reorderLevel: 150,
    prescriptionOnly: true,
    batches: [{ batchNumber: 'AML2404', expiryInDays: 320, qty: 300, unitCost: '0.28' }],
  },
  {
    name: 'Ibuprofen 400mg Tablets',
    genericName: 'Ibuprofen',
    strength: '400 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.70',
    reorderLevel: 100,
    barcode: '6151100070011',
    units: [{ unitName: 'strip', factorToBase: 10, sellingPrice: '6.50' }],
    batches: [{ batchNumber: 'IBU2403', expiryInDays: 85, qty: 220, unitCost: '0.32' }], // expiring
  },
  {
    name: 'Vitamin C 500mg Chewable',
    genericName: 'Ascorbic acid',
    strength: '500 mg',
    form: 'TABLET',
    category: 'Supplements',
    baseUnit: 'tablet',
    sellingPriceBase: '0.40',
    reorderLevel: 100,
    barcode: '6151100080010',
    units: [{ unitName: 'tub (100)', factorToBase: 100, sellingPrice: '35.00' }],
    batches: [{ batchNumber: 'VTC2405', expiryInDays: 550, qty: 800, unitCost: '0.15' }],
  },
  {
    name: 'Multivitamin Syrup 200ml (Haemoglobin+)',
    form: 'SYRUP',
    category: 'Supplements',
    baseUnit: 'bottle',
    sellingPriceBase: '28.00',
    reorderLevel: 12,
    batches: [{ batchNumber: 'MVS2402', expiryInDays: 260, qty: 25, unitCost: '16.00' }],
  },
  {
    name: 'Cetirizine 10mg Tablets',
    genericName: 'Cetirizine',
    strength: '10 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.50',
    reorderLevel: 80,
    batches: [{ batchNumber: 'CET2406', expiryInDays: 480, qty: 350, unitCost: '0.18' }],
  },
  {
    name: 'Omeprazole 20mg Capsules',
    genericName: 'Omeprazole',
    strength: '20 mg',
    form: 'CAPSULE',
    category: 'Medicines',
    baseUnit: 'capsule',
    sellingPriceBase: '1.00',
    reorderLevel: 100,
    batches: [{ batchNumber: 'OME2404', expiryInDays: 390, qty: 280, unitCost: '0.45' }],
  },
  {
    name: 'Salbutamol Inhaler 100mcg (Ventolin generic)',
    genericName: 'Salbutamol',
    strength: '100 mcg/dose',
    form: 'INHALER',
    category: 'Medicines',
    baseUnit: 'inhaler',
    sellingPriceBase: '45.00',
    reorderLevel: 6,
    prescriptionOnly: true,
    batches: [{ batchNumber: 'SAL2403', expiryInDays: 280, qty: 9, unitCost: '30.00' }],
  },
  {
    name: 'Chloramphenicol Eye Drops 0.5%',
    genericName: 'Chloramphenicol',
    strength: '0.5 %',
    form: 'DROPS',
    category: 'Medicines',
    baseUnit: 'bottle',
    sellingPriceBase: '15.00',
    reorderLevel: 8,
    batches: [{ batchNumber: 'CHL2402', expiryInDays: 75, qty: 12, unitCost: '8.00' }], // expiring
  },
  {
    name: 'Hydrocortisone Cream 1% 15g',
    genericName: 'Hydrocortisone',
    strength: '1 %',
    form: 'CREAM',
    category: 'Medicines',
    baseUnit: 'tube',
    sellingPriceBase: '18.00',
    reorderLevel: 10,
    batches: [{ batchNumber: 'HYD2405', expiryInDays: 420, qty: 22, unitCost: '10.50' }],
  },
  {
    name: 'Surgical Gloves (pair, latex)',
    form: 'CONSUMABLE',
    category: 'Medical Supplies',
    baseUnit: 'pair',
    sellingPriceBase: '3.00',
    reorderLevel: 40,
    vatApplies: true,
    units: [{ unitName: 'box (50)', factorToBase: 50, sellingPrice: '130.00' }],
    batches: [{ batchNumber: 'GLV2407', expiryInDays: 900, qty: 250, unitCost: '1.40' }],
  },
  {
    name: 'Digital Thermometer',
    form: 'OTHER',
    category: 'Medical Supplies',
    baseUnit: 'piece',
    sellingPriceBase: '35.00',
    reorderLevel: 5,
    vatApplies: true,
    barcode: '6151100090019',
    batches: [{ batchNumber: 'THM2401', expiryInDays: 1800, qty: 14, unitCost: '20.00' }],
  },
  {
    name: 'Elastoplast Fabric Strips (box)',
    form: 'CONSUMABLE',
    category: 'Medical Supplies',
    baseUnit: 'box',
    sellingPriceBase: '22.00',
    reorderLevel: 10,
    vatApplies: true,
    batches: [{ batchNumber: 'ELP2406', expiryInDays: 1000, qty: 30, unitCost: '13.00' }],
  },
  {
    name: 'Baby Wipes 80s (Cussons)',
    form: 'CONSUMABLE',
    category: 'Baby Care',
    baseUnit: 'pack',
    sellingPriceBase: '25.00',
    reorderLevel: 15,
    vatApplies: true,
    barcode: '6151100100015',
    batches: [{ batchNumber: 'BWP2405', expiryInDays: 600, qty: 40, unitCost: '15.00' }],
  },
  {
    name: 'Infant Formula NAN 1 400g',
    form: 'OTHER',
    category: 'Baby Care',
    baseUnit: 'tin',
    sellingPriceBase: '95.00',
    reorderLevel: 8,
    vatApplies: true,
    batches: [{ batchNumber: 'NAN2404', expiryInDays: 330, qty: 12, unitCost: '70.00' }],
  },
  {
    name: 'Shea Butter Lotion 400ml (Nivea)',
    form: 'OTHER',
    category: 'Cosmetics',
    baseUnit: 'bottle',
    sellingPriceBase: '55.00',
    reorderLevel: 6,
    vatApplies: true,
    barcode: '6151100110014',
    batches: [{ batchNumber: 'NIV2405', expiryInDays: 700, qty: 18, unitCost: '38.00' }],
  },
  {
    name: 'Antiseptic Liquid 250ml (Dettol)',
    form: 'OTHER',
    category: 'Household',
    baseUnit: 'bottle',
    sellingPriceBase: '30.00',
    reorderLevel: 12,
    vatApplies: true,
    barcode: '6151100120013',
    batches: [{ batchNumber: 'DET2406', expiryInDays: 800, qty: 35, unitCost: '19.00' }],
  },
  {
    name: 'Malaria RDT Kit (single)',
    form: 'CONSUMABLE',
    category: 'Medical Supplies',
    baseUnit: 'kit',
    sellingPriceBase: '12.00',
    reorderLevel: 20,
    batches: [{ batchNumber: 'RDT2403', expiryInDays: 200, qty: 55, unitCost: '6.50' }],
  },
  {
    name: 'Zinc Sulphate 20mg Dispersible',
    genericName: 'Zinc sulphate',
    strength: '20 mg',
    form: 'TABLET',
    category: 'Medicines',
    baseUnit: 'tablet',
    sellingPriceBase: '0.60',
    reorderLevel: 60,
    batches: [{ batchNumber: 'ZNC2404', expiryInDays: 460, qty: 150, unitCost: '0.25' }],
  },
];

async function main() {
  console.log('Seeding PharmaTrack…');

  // wipe in FK order
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.saleReturnItem.deleteMany(),
    prisma.saleReturn.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.saleItem.deleteMany(),
    prisma.sale.deleteMany(),
    prisma.stockMovement.deleteMany(),
    prisma.stockAdjustment.deleteMany(),
    prisma.goodsReceiptItem.deleteMany(),
    prisma.goodsReceipt.deleteMany(),
    prisma.purchaseOrderItem.deleteMany(),
    prisma.purchaseOrder.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.priceHistory.deleteMany(),
    prisma.productBarcode.deleteMany(),
    prisma.productUnit.deleteMany(),
    prisma.branchProductSetting.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.supplier.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.userBranch.deleteMany(),
    prisma.user.deleteMany(),
    prisma.branch.deleteMany(),
    prisma.setting.deleteMany(),
  ]);

  const passwordHash = await hash(DEMO_PASSWORD);

  // ── Branch (ADR-010) ───────────────────────────────────────────────────────
  // ONE placeholder, deliberately anonymous. We do not know where the client's
  // shops actually are, and inventing plausible Ghanaian locations would put
  // fabricated client data into a live system (MoU §4 / brief §6). The admin
  // creates the real branches from the Branches screen once site visits confirm
  // them, and renames or deactivates this one. No address or phone is guessed;
  // receipt_header falls back to the global setting until someone fills it in.
  const mainBranch = {
    id: uuid(),
    code: 'MAIN',
    name: 'Main Branch',
  };
  await prisma.branch.create({ data: mainBranch });

  // ── Users: one per role, all at the placeholder branch ─────────────────────
  // A Manager belongs to exactly one branch (ADR-010). Staff for any further
  // branch get created alongside that branch, by the admin.
  const users = [
    { username: 'admin', fullName: 'System Admin', role: 'ADMIN' as const, branch: mainBranch.id },
    { username: 'boateng', fullName: 'Mr. Boateng (Owner)', role: 'MANAGER' as const, branch: mainBranch.id },
    { username: 'adjoa', fullName: 'Adjoa Mensah (Pharmacist)', role: 'PHARMACIST' as const, branch: mainBranch.id },
    { username: 'kwame', fullName: 'Kwame Osei (Inventory)', role: 'INVENTORY_OFFICER' as const, branch: mainBranch.id },
    { username: 'akosua', fullName: 'Akosua Asante (Cashier)', role: 'CASHIER' as const, branch: mainBranch.id },
  ].map((u) => ({ id: uuid(), passwordHash, ...u }));

  await prisma.user.createMany({
    data: users.map(({ branch: _branch, ...u }) => u),
  });
  await prisma.userBranch.createMany({
    data: users.map((u) => ({ userId: u.id, branchId: u.branch, isDefault: true })),
  });
  const admin = users[0];

  // ── Settings ───────────────────────────────────────────────────────────────
  await prisma.setting.createMany({
    data: [
      { key: 'vat_rate', value: 0.15 },
      { key: 'expiry_warn_days', value: 90 },
      { key: 'adjust_approval_threshold', value: 50 },
      {
        key: 'receipt_header',
        value: {
          line1: 'PharmaTrack Demo Pharmacy',
          line2: 'Accra, Ghana',
          line3: 'Tel: 020 000 0000',
        },
      },
    ],
  });

  // ── Suppliers ──────────────────────────────────────────────────────────────
  await prisma.supplier.createMany({
    data: [
      { id: uuid(), name: 'Ernest Chemists Ltd', phone: '0302-660000', createdBy: admin.id },
      { id: uuid(), name: 'Danadams Pharmaceutical', phone: '0302-770000', createdBy: admin.id },
      { id: uuid(), name: 'Tobinco Pharma', phone: '0302-880000', createdBy: admin.id },
    ],
  });

  // ── Categories ─────────────────────────────────────────────────────────────
  const categoryNames = [
    'Medicines',
    'Supplements',
    'Medical Supplies',
    'Baby Care',
    'Cosmetics',
    'Household',
  ];
  const categories = new Map<string, string>();
  for (const name of categoryNames) {
    const id = uuid();
    categories.set(name, id);
    await prisma.category.create({ data: { id, name } });
  }

  // ── Products + units + barcodes + batches + OPENING movements ─────────────
  let productCount = 0;
  let batchCount = 0;
  for (const spec of PRODUCTS) {
    const productId = uuid();
    await prisma.product.create({
      data: {
        id: productId,
        name: spec.name,
        genericName: spec.genericName ?? null,
        strength: spec.strength ?? null,
        form: spec.form,
        categoryId: categories.get(spec.category)!,
        baseUnit: spec.baseUnit,
        sellingPriceBase: new Prisma.Decimal(spec.sellingPriceBase),
        reorderLevel: spec.reorderLevel,
        vatApplies: spec.vatApplies ?? false,
        prescriptionOnly: spec.prescriptionOnly ?? false,
        createdBy: admin.id,
      },
    });
    productCount++;

    if (spec.barcode) {
      await prisma.productBarcode.create({
        data: { id: uuid(), productId, barcode: spec.barcode },
      });
    }

    for (const unit of spec.units ?? []) {
      const unitId = uuid();
      await prisma.productUnit.create({
        data: {
          id: unitId,
          productId,
          unitName: unit.unitName,
          factorToBase: unit.factorToBase,
          sellingPrice: new Prisma.Decimal(unit.sellingPrice),
        },
      });
      if (unit.barcode) {
        await prisma.productBarcode.create({
          data: { id: uuid(), productId, productUnitId: unitId, barcode: unit.barcode },
        });
      }
    }

    // All demo stock sits at the placeholder branch. Stock for any further
    // branch arrives the way it will in reality — a goods receipt or a transfer.
    const stockPlan: { branchId: string; batches: BatchSpec[] }[] = [
      { branchId: mainBranch.id, batches: spec.batches },
    ];

    for (const { branchId, batches } of stockPlan) {
      for (const b of batches) {
        const batchId = uuid();
        const expired = b.expiryInDays < 0;
        await prisma.batch.create({
          data: {
            id: batchId,
            branchId,
            productId,
            batchNumber: b.batchNumber,
            expiryDate: daysFromNow(b.expiryInDays),
            qtyOnHand: b.qty,
            unitCost: new Prisma.Decimal(b.unitCost),
            status: expired ? 'EXPIRED' : 'ACTIVE',
          },
        });
        await prisma.stockMovement.create({
          data: {
            branchId,
            productId,
            batchId,
            qtyDelta: b.qty,
            type: 'OPENING',
            refType: 'opening_balance',
            refId: batchId,
            unitCost: new Prisma.Decimal(b.unitCost),
            performedBy: admin.id,
          },
        });
        batchCount++;
      }
    }

  }

  console.log(
    `Seeded: 1 placeholder branch (${mainBranch.code} — rename it, or create the real ` +
      `branches from the Branches screen), ${users.length} users ` +
      `(password: ${DEMO_PASSWORD}), ${categoryNames.length} categories, ` +
      `${productCount} products, ${batchCount} batches.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
