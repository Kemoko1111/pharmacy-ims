import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, AdjustmentReason } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { listEnvelope } from '../../common/pagination';
import type { RequestUser } from '../../common/jwt-auth.guard';

const adjInclude = {
  product: { select: { name: true, baseUnit: true } },
  batch: { select: { batchNumber: true, expiryDate: true, qtyOnHand: true, unitCost: true } },
} satisfies Prisma.StockAdjustmentInclude;

@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * BR-05: adjustments whose value at cost stays within the
   * `adjust_approval_threshold` setting post immediately; anything bigger
   * waits in the Manager's approval queue.
   */
  async create(
    dto: { productId: string; batchId: string; qtyDelta: number; reason: AdjustmentReason; note?: string },
    actor: RequestUser,
  ) {
    const batch = await this.prisma.batch.findUnique({ where: { id: dto.batchId } });
    if (!batch || batch.productId !== dto.productId) {
      throw new DomainException('BATCH_MISMATCH', 'Batch does not belong to this product');
    }
    if (dto.qtyDelta < 0 && batch.qtyOnHand + dto.qtyDelta < 0) {
      throw new DomainException('ADJUST_BELOW_ZERO', 'Adjustment would drive the batch negative', {
        qtyOnHand: batch.qtyOnHand,
      });
    }

    const threshold = Number(
      (await this.prisma.setting.findUnique({ where: { key: 'adjust_approval_threshold' } }))?.value ?? 0,
    );
    const value = batch.unitCost.mul(Math.abs(dto.qtyDelta));
    const autoApprove = value.lte(threshold) && Number.isFinite(threshold);

    const id = uuid();
    await this.prisma.$transaction(async (tx) => {
      await tx.stockAdjustment.create({
        data: {
          id,
          // The batch lookup above is branch-scoped, so this is always the
          // actor's own branch — taking it from the batch keeps the
          // adjustment and the stock it moves on the same branch by construction.
          branchId: batch.branchId,
          productId: dto.productId,
          batchId: dto.batchId,
          qtyDelta: dto.qtyDelta,
          reason: dto.reason,
          note: dto.note ?? null,
          status: autoApprove ? 'APPROVED' : 'PENDING_APPROVAL',
          requestedBy: actor.id,
          ...(autoApprove ? { approvedBy: actor.id, decidedAt: new Date() } : {}),
        },
      });
      if (autoApprove) {
        await this.postMovement(tx, id, { ...dto, branchId: batch.branchId }, batch.unitCost, actor.id);
      }
    });

    await this.audit.log({
      userId: actor.id,
      action: autoApprove ? 'adjustment.auto_approved' : 'adjustment.requested',
      entity: 'stock_adjustment',
      entityId: id,
      after: { qtyDelta: dto.qtyDelta, reason: dto.reason, value: value.toString() },
    });
    return this.get(id);
  }

  async decide(id: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, actor: RequestUser) {
    await this.prisma.$transaction(async (tx) => {
      const adj = await tx.stockAdjustment.findUnique({ where: { id }, include: { batch: true } });
      if (!adj) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Adjustment not found' });
      if (adj.status !== 'PENDING_APPROVAL') {
        throw new DomainException('ALREADY_DECIDED', `Adjustment is already ${adj.status}`);
      }
      if (decision === 'APPROVED' && adj.qtyDelta < 0 && adj.batch.qtyOnHand + adj.qtyDelta < 0) {
        throw new DomainException('ADJUST_BELOW_ZERO', 'Stock has moved; approval would drive the batch negative', {
          qtyOnHand: adj.batch.qtyOnHand,
        });
      }

      await tx.stockAdjustment.update({
        where: { id },
        data: {
          status: decision,
          approvedBy: actor.id,
          decidedAt: new Date(),
          ...(note ? { note: [adj.note, `[decision] ${note}`].filter(Boolean).join(' — ') } : {}),
        },
      });

      if (decision === 'APPROVED') {
        await this.postMovement(
          tx,
          id,
          {
            branchId: adj.branchId,
            productId: adj.productId,
            batchId: adj.batchId,
            qtyDelta: adj.qtyDelta,
            reason: adj.reason,
          },
          adj.batch.unitCost,
          actor.id,
        );
      }
    });

    await this.audit.log({
      userId: actor.id,
      action: `adjustment.${decision.toLowerCase()}`,
      entity: 'stock_adjustment',
      entityId: id,
    });
    return this.get(id);
  }

  /**
   * Bulk "Quarantine expired" (Screen 6): expired-but-stocked batches stop
   * selling immediately (QUARANTINED); the write-off itself is a disposal
   * adjustment that still needs Manager approval.
   */
  async quarantineExpired(actor: RequestUser) {
    const expired = await this.prisma.batch.findMany({
      where: {
        qtyOnHand: { gt: 0 },
        OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiryDate: { lte: new Date() } }],
      },
    });
    if (expired.length === 0) return { quarantined: 0, adjustments: [] as string[] };

    const created: string[] = [];
    for (const batch of expired) {
      await this.prisma.batch.update({ where: { id: batch.id }, data: { status: 'QUARANTINED' } });
      const adj = await this.prisma.stockAdjustment.create({
        data: {
          id: uuid(),
          branchId: batch.branchId,
          productId: batch.productId,
          batchId: batch.id,
          qtyDelta: -batch.qtyOnHand,
          reason: 'EXPIRY_DISPOSAL',
          note: `Bulk quarantine of expired batch ${batch.batchNumber}`,
          status: 'PENDING_APPROVAL',
          requestedBy: actor.id,
        },
      });
      created.push(adj.id);
    }

    await this.audit.log({
      userId: actor.id,
      action: 'batch.quarantine_expired',
      entity: 'batch',
      entityId: 'bulk',
      after: { count: expired.length },
    });
    return { quarantined: expired.length, adjustments: created };
  }

  async list(opts: { page: number; pageSize: number; status?: string }) {
    const where: Prisma.StockAdjustmentWhereInput = opts.status
      ? { status: opts.status as Prisma.StockAdjustmentWhereInput['status'] }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockAdjustment.findMany({
        where,
        include: adjInclude,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.stockAdjustment.count({ where }),
    ]);
    return listEnvelope(rows.map((a) => this.serialize(a)), opts.page, opts.pageSize, total);
  }

  async get(id: string) {
    const adj = await this.prisma.stockAdjustment.findUnique({ where: { id }, include: adjInclude });
    if (!adj) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Adjustment not found' });
    return this.serialize(adj);
  }

  private async postMovement(
    tx: Prisma.TransactionClient,
    adjustmentId: string,
    dto: { branchId: string; productId: string; batchId: string; qtyDelta: number; reason: AdjustmentReason },
    unitCost: Prisma.Decimal,
    actorId: string,
  ) {
    await tx.stockMovement.create({
      data: {
        branchId: dto.branchId,
        productId: dto.productId,
        batchId: dto.batchId,
        qtyDelta: dto.qtyDelta,
        type: dto.reason === 'EXPIRY_DISPOSAL' ? 'DISPOSAL' : 'ADJUSTMENT',
        refType: 'stock_adjustment',
        refId: adjustmentId,
        unitCost,
        performedBy: actorId,
      },
    });
    const updated = await tx.batch.update({
      where: { id: dto.batchId },
      data: { qtyOnHand: { increment: dto.qtyDelta } },
      select: { qtyOnHand: true, status: true },
    });
    if (updated.qtyOnHand === 0 && updated.status === 'ACTIVE') {
      await tx.batch.update({ where: { id: dto.batchId }, data: { status: 'DEPLETED' } });
    }
  }

  private serialize(a: Prisma.StockAdjustmentGetPayload<{ include: typeof adjInclude }>) {
    return {
      id: a.id,
      productId: a.productId,
      productName: a.product.name,
      baseUnit: a.product.baseUnit,
      batchId: a.batchId,
      batchNumber: a.batch.batchNumber,
      qtyDelta: a.qtyDelta,
      valueAtCost: a.batch.unitCost.mul(Math.abs(a.qtyDelta)),
      reason: a.reason,
      note: a.note,
      status: a.status,
      requestedBy: a.requestedBy,
      approvedBy: a.approvedBy,
      decidedAt: a.decidedAt,
      createdAt: a.createdAt,
    };
  }
}
