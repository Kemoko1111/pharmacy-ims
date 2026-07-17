import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { listEnvelope } from '../../common/pagination';
import { BatchesQuery, MovementsQuery } from './dto';

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
        include: { product: { select: { name: true, baseUnit: true } } },
        orderBy: { expiryDate: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.batch.count({ where }),
    ]);
    return listEnvelope(
      rows.map((b) => ({
        id: b.id,
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

  async stock(lowStock?: string) {
    // reads the v_stock_on_hand view from the Week 3 DDL
    const rows = await this.prisma.$queryRaw<
      { product_id: string; name: string; base_unit: string; qty_base: bigint; value_at_cost: Prisma.Decimal; reorder_level: number }[]
    >`SELECT * FROM v_stock_on_hand ORDER BY name`;
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
