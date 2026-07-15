import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { listEnvelope } from '../../common/pagination';
import { AddBarcodeDto, AddUnitDto, CreateProductDto, ProductsQuery, UpdateProductDto } from './dto';
import type { RequestUser } from '../../common/jwt-auth.guard';

const MANAGER_ROLES = ['MANAGER', 'ADMIN'];

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Products ───────────────────────────────────────────────────────────────

  async listProducts(q: ProductsQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;

    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              { genericName: { contains: q.q, mode: 'insensitive' } },
              { barcodes: { some: { barcode: q.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: {
          category: { select: { name: true } },
          units: { where: { isActive: true }, orderBy: { factorToBase: 'asc' } },
          barcodes: true,
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    const stock = await this.stockByProduct(rows.map((r) => r.id));
    let data = rows.map((r) => this.toSummary(r, stock));
    if (q.lowStock === 'true') {
      data = data.filter((p) => p.qtyOnHand <= p.reorderLevel);
    }
    return listEnvelope(data, page, pageSize, total);
  }

  async getProduct(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        category: { select: { name: true } },
        units: { orderBy: { factorToBase: 'asc' } },
        barcodes: true,
        batches: {
          where: { status: 'ACTIVE', qtyOnHand: { gt: 0 } },
          orderBy: { expiryDate: 'asc' },
        },
      },
    });
    if (!product) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });
    const stock = await this.stockByProduct([id]);
    return {
      ...this.toSummary(product, stock),
      notes: product.notes,
      legacyItemNo: product.legacyItemNo,
      batches: product.batches.map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate.toISOString().slice(0, 10),
        qtyOnHand: b.qtyOnHand,
        status: b.status,
      })),
    };
  }

  async createProduct(dto: CreateProductDto, actor: RequestUser) {
    const id = uuid();
    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          id,
          name: dto.name,
          genericName: dto.genericName ?? null,
          strength: dto.strength ?? null,
          form: dto.form,
          categoryId: dto.categoryId,
          baseUnit: dto.baseUnit,
          sellingPriceBase: new Prisma.Decimal(dto.sellingPriceBase),
          reorderLevel: dto.reorderLevel,
          vatApplies: dto.vatApplies,
          prescriptionOnly: dto.prescriptionOnly,
          notes: dto.notes ?? null,
          legacyItemNo: dto.legacyItemNo ?? null,
          createdBy: actor.id,
        },
      });
      for (const u of dto.units ?? []) {
        await tx.productUnit.create({
          data: {
            id: uuid(),
            productId: id,
            unitName: u.unitName,
            factorToBase: u.factorToBase,
            sellingPrice: new Prisma.Decimal(u.sellingPrice),
          },
        });
      }
      for (const code of dto.barcodes ?? []) {
        await tx.productBarcode.create({ data: { id: uuid(), productId: id, barcode: code } });
      }
      return created;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'product.create',
      entity: 'product',
      entityId: id,
      after: { name: product.name, sellingPriceBase: product.sellingPriceBase },
    });
    return this.getProduct(id);
  }

  async updateProduct(id: string, dto: UpdateProductDto, actor: RequestUser) {
    const before = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });

    const priceChanged =
      dto.sellingPriceBase !== undefined &&
      !new Prisma.Decimal(dto.sellingPriceBase).equals(before.sellingPriceBase);

    // BR-03: price changes are Manager+ only and land in price_history
    if (priceChanged && !MANAGER_ROLES.includes(actor.role)) {
      throw new DomainException('PRICE_CHANGE_FORBIDDEN', 'Only a Manager can change prices');
    }

    const product = await this.prisma.$transaction(async (tx) => {
      if (priceChanged) {
        await tx.priceHistory.create({
          data: {
            id: uuid(),
            productId: id,
            oldPrice: before.sellingPriceBase,
            newPrice: new Prisma.Decimal(dto.sellingPriceBase!),
            changedBy: actor.id,
          },
        });
      }
      return tx.product.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.genericName !== undefined ? { genericName: dto.genericName } : {}),
          ...(dto.strength !== undefined ? { strength: dto.strength } : {}),
          ...(dto.form !== undefined ? { form: dto.form } : {}),
          ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
          ...(dto.sellingPriceBase !== undefined
            ? { sellingPriceBase: new Prisma.Decimal(dto.sellingPriceBase) }
            : {}),
          ...(dto.reorderLevel !== undefined ? { reorderLevel: dto.reorderLevel } : {}),
          ...(dto.vatApplies !== undefined ? { vatApplies: dto.vatApplies } : {}),
          ...(dto.prescriptionOnly !== undefined ? { prescriptionOnly: dto.prescriptionOnly } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedBy: actor.id,
        },
      });
    });

    await this.audit.log({
      userId: actor.id,
      action: priceChanged ? 'product.price_change' : 'product.update',
      entity: 'product',
      entityId: id,
      before: { sellingPriceBase: before.sellingPriceBase, name: before.name },
      after: { sellingPriceBase: product.sellingPriceBase, name: product.name },
    });
    return this.getProduct(id);
  }

  async softDeleteProduct(id: string, actor: RequestUser) {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log({
      userId: actor.id,
      action: 'product.delete',
      entity: 'product',
      entityId: id,
      before: { name: product.name },
    });
  }

  async addUnit(productId: string, dto: AddUnitDto, actor: RequestUser) {
    await this.ensureProduct(productId);
    const unit = await this.prisma.productUnit.create({
      data: {
        id: uuid(),
        productId,
        unitName: dto.unitName,
        factorToBase: dto.factorToBase,
        sellingPrice: new Prisma.Decimal(dto.sellingPrice),
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'product.add_unit',
      entity: 'product',
      entityId: productId,
      after: { unitName: unit.unitName, factorToBase: unit.factorToBase },
    });
    return unit;
  }

  /** US-04 AC3: units are retired, never edited — history keeps the old unit. */
  async retireUnit(productId: string, unitId: string, actor: RequestUser) {
    const unit = await this.prisma.productUnit.findUnique({ where: { id: unitId } });
    if (!unit || unit.productId !== productId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Unit not found on this product' });
    }
    if (!unit.isActive) {
      throw new DomainException('ALREADY_RETIRED', 'Unit is already retired');
    }
    const updated = await this.prisma.productUnit.update({
      where: { id: unitId },
      data: { isActive: false },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'product.retire_unit',
      entity: 'product',
      entityId: productId,
      before: { unitName: unit.unitName, isActive: true },
      after: { unitName: unit.unitName, isActive: false },
    });
    return updated;
  }

  async addBarcode(productId: string, dto: AddBarcodeDto, actor: RequestUser) {
    await this.ensureProduct(productId);
    const barcode = await this.prisma.productBarcode.create({
      data: {
        id: uuid(),
        productId,
        productUnitId: dto.productUnitId ?? null,
        barcode: dto.barcode,
      },
    });
    await this.audit.log({
      userId: actor.id,
      action: 'product.add_barcode',
      entity: 'product',
      entityId: productId,
      after: { barcode: dto.barcode },
    });
    return barcode;
  }

  // ── Barcode lookup (US-06 AC1) ─────────────────────────────────────────────

  async lookupBarcode(code: string) {
    const hit = await this.prisma.productBarcode.findUnique({
      where: { barcode: code },
      include: {
        product: {
          include: { units: { where: { isActive: true } } },
        },
        unit: true,
      },
    });
    if (!hit || hit.product.deletedAt) {
      throw new NotFoundException({ code: 'BARCODE_UNKNOWN', message: 'No product with this barcode' });
    }
    const stock = await this.stockByProduct([hit.productId]);
    return {
      product: this.toSummary(hit.product, stock),
      unit: hit.unit
        ? {
            id: hit.unit.id,
            unitName: hit.unit.unitName,
            factorToBase: hit.unit.factorToBase,
            sellingPrice: hit.unit.sellingPrice,
            isActive: hit.unit.isActive,
          }
        : null,
    };
  }

  // ── Categories ─────────────────────────────────────────────────────────────

  listCategories() {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  createCategory(name: string) {
    return this.prisma.category.create({ data: { id: uuid(), name } });
  }

  // ── Offline snapshot (ADR-006) ─────────────────────────────────────────────

  async snapshot() {
    const [products, batches] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where: { deletedAt: null },
        include: {
          units: { where: { isActive: true } },
          barcodes: true,
          category: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.batch.findMany({
        where: { status: 'ACTIVE', qtyOnHand: { gt: 0 } },
        orderBy: { expiryDate: 'asc' },
      }),
    ]);

    const stock = new Map<string, { qty: number; nearest: Date | null }>();
    for (const b of batches) {
      const cur = stock.get(b.productId) ?? { qty: 0, nearest: null };
      cur.qty += b.qtyOnHand;
      if (!cur.nearest || b.expiryDate < cur.nearest) cur.nearest = b.expiryDate;
      stock.set(b.productId, cur);
    }

    return {
      version: new Date().toISOString(),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        genericName: p.genericName,
        strength: p.strength,
        form: p.form,
        categoryName: p.category.name,
        baseUnit: p.baseUnit,
        sellingPriceBase: p.sellingPriceBase,
        vatApplies: p.vatApplies,
        prescriptionOnly: p.prescriptionOnly,
        reorderLevel: p.reorderLevel,
        qtyOnHand: stock.get(p.id)?.qty ?? 0,
        nearestExpiry: stock.get(p.id)?.nearest?.toISOString().slice(0, 10) ?? null,
        units: p.units.map((u) => ({
          id: u.id,
          unitName: u.unitName,
          factorToBase: u.factorToBase,
          sellingPrice: u.sellingPrice,
        })),
        barcodes: p.barcodes.map((b) => ({ barcode: b.barcode, productUnitId: b.productUnitId })),
      })),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async ensureProduct(id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });
    return p;
  }

  private async stockByProduct(productIds: string[]) {
    if (productIds.length === 0) return new Map<string, { qty: number; nearest: Date | null }>();
    const batches = await this.prisma.batch.findMany({
      where: { productId: { in: productIds }, status: 'ACTIVE' },
      select: { productId: true, qtyOnHand: true, expiryDate: true },
    });
    const map = new Map<string, { qty: number; nearest: Date | null }>();
    for (const b of batches) {
      const cur = map.get(b.productId) ?? { qty: 0, nearest: null };
      cur.qty += b.qtyOnHand;
      if (b.qtyOnHand > 0 && (!cur.nearest || b.expiryDate < cur.nearest)) cur.nearest = b.expiryDate;
      map.set(b.productId, cur);
    }
    return map;
  }

  private toSummary(
    p: {
      id: string;
      name: string;
      genericName: string | null;
      strength: string | null;
      form: string;
      categoryId: string;
      baseUnit: string;
      sellingPriceBase: Prisma.Decimal;
      reorderLevel: number;
      vatApplies: boolean;
      prescriptionOnly: boolean;
      category?: { name: string };
      units?: unknown[];
      barcodes?: unknown[];
    },
    stock: Map<string, { qty: number; nearest: Date | null }>,
  ) {
    return {
      id: p.id,
      name: p.name,
      genericName: p.genericName,
      strength: p.strength,
      form: p.form,
      categoryId: p.categoryId,
      categoryName: p.category?.name,
      baseUnit: p.baseUnit,
      sellingPriceBase: p.sellingPriceBase,
      reorderLevel: p.reorderLevel,
      vatApplies: p.vatApplies,
      prescriptionOnly: p.prescriptionOnly,
      qtyOnHand: stock.get(p.id)?.qty ?? 0,
      nearestExpiry: stock.get(p.id)?.nearest?.toISOString().slice(0, 10) ?? null,
      units: p.units,
      barcodes: p.barcodes,
    };
  }
}
