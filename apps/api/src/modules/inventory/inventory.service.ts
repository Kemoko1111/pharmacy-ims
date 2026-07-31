import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { listEnvelope } from '../../common/pagination';
import { BatchesQuery, MovementsQuery } from './dto';

interface StockRow {
  product_id: string;
  name: string;
  base_unit: string;
  qty_base: bigint;
  value_at_cost: Prisma.Decimal;
  reorder_level: number;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listBatches(q: BatchesQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const where: Prisma.BatchWhereInput = {
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.status ? { status: q.status as Prisma.BatchWhereInput['status'] } : {}),
      ...(q.expiringWithinDays
        ? {
            expiryDate: { lte: new Date(Date.now() + q.expiringWithinDays * 86_400_000) },
            qtyOnHand: { gt: 0 },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.batch.findMany({
        where,
        include: {
          product: { select: { name: true, baseUnit: true } },
          branch: { select: { code: true } },
        },
        orderBy: { expiryDate: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.batch.count({ where }),
    ]);
    return listEnvelope(
      rows.map((b) => ({
        id: b.id,
        branchId: b.branchId,
        branchCode: b.branch.code,
        productId: b.productId,
        productName: b.product.name,
        baseUnit: b.product.baseUnit,
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate.toISOString().slice(0, 10),
        daysToExpiry: Math.ceil((b.expiryDate.getTime() - Date.now()) / 86_400_000),
        qtyOnHand: b.qtyOnHand,
        unitCost: b.unitCost,
        valueAtCost: b.unitCost.mul(b.qtyOnHand),
        status: b.status,
      })),
      page,
      pageSize,
      total,
    );
  }

  /**
   * Reads v_stock_on_hand, which since ADR-010 has one row per branch × product.
   * Without the branch predicate this returns every product once per branch —
   * raw SQL is outside the branch-scope extension, so the filter is explicit.
   * A null branch is consolidated mode: sum the branches back together.
   */
  async stock(branchId: string | null, lowStock?: string) {
    const rows = branchId
      ? await this.prisma.$queryRaw<StockRow[]>`
          SELECT product_id, name, base_unit, qty_base, value_at_cost, reorder_level
          FROM v_stock_on_hand
          WHERE branch_id = ${branchId}::uuid
          ORDER BY name`
      : await this.prisma.$queryRaw<StockRow[]>`
          SELECT product_id, name, base_unit,
                 SUM(qty_base) AS qty_base,
                 SUM(value_at_cost)::numeric(14,2) AS value_at_cost,
                 MAX(reorder_level) AS reorder_level
          FROM v_stock_on_hand
          GROUP BY product_id, name, base_unit
          ORDER BY name`;

    return rows
      .map((r) => ({
        productId: r.product_id,
        name: r.name,
        baseUnit: r.base_unit,
        qtyBase: Number(r.qty_base),
        valueAtCost: r.value_at_cost,
        reorderLevel: r.reorder_level,
      }))
      .filter((r) => (lowStock === 'true' ? r.qtyBase <= r.reorderLevel : true));
  }

  async movements(q: MovementsQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const where: Prisma.StockMovementWhereInput = {
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.type ? { type: q.type as Prisma.StockMovementWhereInput['type'] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          product: { select: { name: true } },
          batch: { select: { batchNumber: true } },
          performer: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return listEnvelope(
      rows.map((m) => ({
        id: m.id.toString(),
        productName: m.product.name,
        batchNumber: m.batch.batchNumber,
        qtyDelta: m.qtyDelta,
        type: m.type,
        refType: m.refType,
        refId: m.refId,
        performedBy: m.performer.fullName,
        createdAt: m.createdAt,
      })),
      page,
      pageSize,
      total,
    );
  }
}
