import { Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { fromPesewas, toPesewas } from '../../common/money';
import type { RequestUser } from '../../common/jwt-auth.guard';

export interface ReturnItemInput {
  saleItemId: string;
  qtyBase: number;
  restock: boolean;
}

/**
 * US-14: returns are posted by a Pharmacist/Manager (the role IS the
 * approval — no PIN system in MVP). Refunds are pro-rated per base unit of
 * the product+unit group, because FEFO may have split one till line into
 * several sale_items with the money carried on the first split.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: { saleId: string; items: ReturnItemInput[]; reason: string },
    actor: RequestUser,
  ) {
    const returnId = await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: dto.saleId },
        include: { items: true, returns: { include: { items: true } } },
      });
      if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
      if (sale.status !== 'COMPLETED') {
        throw new DomainException('SALE_NOT_COMPLETED', 'Only completed sales can take returns');
      }

      // Already-returned base units per sale item
      const returned = new Map<string, number>();
      for (const r of sale.returns) {
        for (const ri of r.items) {
          returned.set(ri.saleItemId, (returned.get(ri.saleItemId) ?? 0) + ri.qtyBase);
        }
      }

      // Pro-rated price per base unit for each product+unit group
      const groupKey = (i: { productId: string; productUnitId: string | null }) =>
        `${i.productId}:${i.productUnitId ?? 'base'}`;
      const groups = new Map<string, { qtyBase: number; lineTotalP: number }>();
      for (const item of sale.items) {
        const g = groups.get(groupKey(item)) ?? { qtyBase: 0, lineTotalP: 0 };
        g.qtyBase += item.qtyBase;
        g.lineTotalP += toPesewas(item.lineTotal);
        groups.set(groupKey(item), g);
      }

      let refundTotalP = 0;
      const returnId = uuid();
      const lines: { saleItemId: string; qtyBase: number; restock: boolean }[] = [];

      for (const input of dto.items) {
        const item = sale.items.find((i) => i.id === input.saleItemId);
        if (!item) {
          throw new DomainException('ITEM_NOT_ON_SALE', 'Return line does not belong to this sale', {
            saleItemId: input.saleItemId,
          });
        }
        const already = returned.get(item.id) ?? 0;
        if (input.qtyBase + already > item.qtyBase) {
          throw new DomainException('RETURN_EXCEEDS_SOLD', 'Returning more than was sold on this line', {
            saleItemId: item.id,
            sold: item.qtyBase,
            alreadyReturned: already,
          });
        }

        const group = groups.get(groupKey(item))!;
        refundTotalP += Math.round((group.lineTotalP * input.qtyBase) / group.qtyBase);
        lines.push({ saleItemId: item.id, qtyBase: input.qtyBase, restock: input.restock });

        if (input.restock) {
          await tx.stockMovement.create({
            data: {
              productId: item.productId,
              batchId: item.batchId,
              qtyDelta: input.qtyBase,
              type: 'RETURN_IN',
              refType: 'sale_return',
              refId: returnId,
              performedBy: actor.id,
            },
          });
          await tx.batch.update({
            where: { id: item.batchId },
            data: { qtyOnHand: { increment: input.qtyBase }, status: 'ACTIVE' },
          });
        }
      }

      await tx.saleReturn.create({
        data: {
          id: returnId,
          saleId: sale.id,
          reason: dto.reason,
          refundTotal: fromPesewas(refundTotalP),
          approvedBy: actor.id,
          processedBy: actor.id,
        },
      });
      for (const line of lines) {
        await tx.saleReturnItem.create({ data: { id: uuid(), saleReturnId: returnId, ...line } });
      }
      return returnId;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'sale.return',
      entity: 'sale_return',
      entityId: returnId,
      after: { saleId: dto.saleId, reason: dto.reason },
    });
    return this.get(returnId);
  }

  async get(id: string) {
    const r = await this.prisma.saleReturn.findUnique({
      where: { id },
      include: {
        sale: { select: { receiptNumber: true } },
        items: {
          include: {
            saleItem: { include: { product: { select: { name: true, baseUnit: true } } } },
          },
        },
      },
    });
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Return not found' });
    return {
      id: r.id,
      saleId: r.saleId,
      receiptNumber: r.sale.receiptNumber,
      reason: r.reason,
      refundTotal: r.refundTotal,
      createdAt: r.createdAt,
      items: r.items.map((i) => ({
        saleItemId: i.saleItemId,
        productName: i.saleItem.product.name,
        baseUnit: i.saleItem.product.baseUnit,
        qtyBase: i.qtyBase,
        restock: i.restock,
      })),
    };
  }
}
