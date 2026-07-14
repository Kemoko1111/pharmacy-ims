import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PageQuery, listEnvelope } from '../../common/pagination';
import { Roles } from '../../common/roles.decorator';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

class BatchesQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expiringWithinDays?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

class MovementsQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  type?: string;
}

@Controller()
export class InventoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('batches')
  async listBatches(@Query() q: BatchesQuery) {
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

  @Get('inventory/stock')
  async stock(@Query('lowStock') lowStock?: string) {
    // reads the v_stock_on_hand view from the Week 3 DDL
    const rows = await this.prisma.$queryRaw<
      { product_id: string; name: string; base_unit: string; qty_base: bigint; value_at_cost: Prisma.Decimal; reorder_level: number }[]
    >`SELECT * FROM v_stock_on_hand ORDER BY name`;
    const data = rows
      .map((r) => ({
        productId: r.product_id,
        name: r.name,
        baseUnit: r.base_unit,
        qtyBase: Number(r.qty_base),
        valueAtCost: r.value_at_cost,
        reorderLevel: r.reorder_level,
      }))
      .filter((r) => (lowStock === 'true' ? r.qtyBase <= r.reorderLevel : true));
    return data;
  }

  @Get('inventory/movements')
  @Roles('MANAGER')
  async movements(@Query() q: MovementsQuery) {
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
