import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { listEnvelope } from '../../common/pagination';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { CreateTransferDto, ReceiveTransferDto } from './dto';

const transferInclude = {
  items: { include: { product: { select: { name: true, baseUnit: true } } } },
  fromBranch: { select: { code: true, name: true } },
  toBranch: { select: { code: true, name: true } },
} satisfies Prisma.StockTransferInclude;

/**
 * Stock transfers between branches (ADR-010, Phase 6).
 *
 * Deliberately two-sided. Dispatch only touches the sending branch; receipt
 * only touches the receiving one. That mirrors what physically happens — staff
 * at each end handle their own half — and means no operation ever writes across
 * a branch boundary, so the isolation model holds without exceptions.
 *
 * StockTransfer is not in the branch-scope extension's strict list because it
 * belongs to two branches at once; visibility (`from OR to`) is applied here.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private actorBranch(actor: RequestUser, action: string): string {
    if (!actor.branchId) {
      throw new DomainException('BRANCH_REQUIRED', `Select a branch to ${action}`);
    }
    return actor.branchId;
  }

  /** A branch sees what it is sending and what is coming to it — nothing else. */
  private visibility(actor: RequestUser): Prisma.StockTransferWhereInput {
    if (!actor.branchId) return {}; // consolidated (ADMIN) — read-only by construction
    return {
      OR: [{ fromBranchId: actor.branchId }, { toBranchId: actor.branchId }],
    };
  }

  async list(actor: RequestUser, opts: { page: number; pageSize: number; status?: string }) {
    const where: Prisma.StockTransferWhereInput = {
      ...this.visibility(actor),
      ...(opts.status ? { status: opts.status as Prisma.StockTransferWhereInput['status'] } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        include: transferInclude,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return listEnvelope(rows.map((t) => this.serialize(t)), opts.page, opts.pageSize, total);
  }

  async get(id: string, actor: RequestUser) {
    const transfer = await this.prisma.stockTransfer.findFirst({
      where: { id, ...this.visibility(actor) },
      include: transferInclude,
    });
    if (!transfer) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found' });
    return this.serialize(transfer);
  }

  /**
   * Draft a transfer out of this branch. Stock does not move yet — the batches
   * named here stay sellable until dispatch, so a draft cannot strand stock.
   */
  async create(dto: CreateTransferDto, actor: RequestUser) {
    const fromBranchId = this.actorBranch(actor, 'raise a transfer');
    if (dto.toBranchId === fromBranchId) {
      throw new DomainException('SAME_BRANCH', 'Source and destination must differ');
    }
    const destination = await this.prisma.branch.findFirst({
      where: { id: dto.toBranchId, isActive: true },
      select: { id: true },
    });
    if (!destination) throw new DomainException('BRANCH_UNKNOWN', 'Destination branch not found');

    const batchIds = dto.items.map((i) => i.sourceBatchId);
    if (new Set(batchIds).size !== batchIds.length) {
      throw new DomainException('DUPLICATE_TRANSFER_LINE', 'A batch appears twice on the transfer');
    }

    // Branch-scoped by the extension, so a batch at another branch simply is
    // not found — a transfer can only ever send this branch's own stock.
    const batches = await this.prisma.batch.findMany({
      where: { id: { in: batchIds }, status: 'ACTIVE' },
    });
    if (batches.length !== batchIds.length) {
      throw new DomainException('BATCH_UNKNOWN', 'One or more batches are not active stock at this branch');
    }
    const byId = new Map(batches.map((b) => [b.id, b]));

    for (const item of dto.items) {
      const batch = byId.get(item.sourceBatchId)!;
      if (item.qtyBase > batch.qtyOnHand) {
        throw new DomainException('INSUFFICIENT_STOCK', `Batch ${batch.batchNumber}: only ${batch.qtyOnHand} on hand`, {
          sourceBatchId: batch.id,
          qtyOnHand: batch.qtyOnHand,
        });
      }
    }

    const id = uuid();
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: fromBranchId },
      select: { code: true },
    });
    const seq = await this.prisma.stockTransfer.count({ where: { fromBranchId } });
    const transferNumber = `${branch.code}-TRF-${new Date().getFullYear()}-${String(seq + 1).padStart(4, '0')}`;

    await this.prisma.stockTransfer.create({
      data: {
        id,
        transferNumber,
        fromBranchId,
        toBranchId: dto.toBranchId,
        status: 'DRAFT',
        notes: dto.notes ?? null,
        createdBy: actor.id,
        items: {
          create: dto.items.map((item) => {
            const batch = byId.get(item.sourceBatchId)!;
            return {
              id: uuid(),
              productId: batch.productId,
              sourceBatchId: batch.id,
              batchNumber: batch.batchNumber,
              expiryDate: batch.expiryDate,
              qtyBase: item.qtyBase,
              unitCost: batch.unitCost,
            };
          }),
        },
      },
    });

    await this.audit.log({
      userId: actor.id,
      action: 'transfer.create',
      entity: 'stock_transfer',
      entityId: id,
      after: { transferNumber, toBranchId: dto.toBranchId, lines: dto.items.length },
    });
    return this.get(id, actor);
  }

  /**
   * Goods leave the sending branch. Stock comes off the shelf now so it cannot
   * be sold twice, but it stays this branch's asset (v_in_transit) until the
   * far end confirms receipt.
   */
  async dispatch(id: string, actor: RequestUser) {
    const branchId = this.actorBranch(actor, 'dispatch a transfer');

    await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id, fromBranchId: branchId },
        include: { items: true },
      });
      if (!transfer) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found for this branch' });
      }
      if (transfer.status !== 'DRAFT') {
        throw new DomainException('TRANSFER_NOT_DRAFT', `Cannot dispatch a ${transfer.status} transfer`);
      }

      for (const item of transfer.items) {
        // Re-read under the transaction: the draft may be hours old and the
        // stock could have been sold or adjusted since.
        const batch = await tx.batch.findFirst({ where: { id: item.sourceBatchId } });
        if (!batch) throw new DomainException('BATCH_UNKNOWN', 'Source batch no longer available');
        if (batch.qtyOnHand < item.qtyBase) {
          throw new DomainException(
            'INSUFFICIENT_STOCK',
            `Batch ${batch.batchNumber}: only ${batch.qtyOnHand} left, cannot send ${item.qtyBase}`,
            { sourceBatchId: batch.id, qtyOnHand: batch.qtyOnHand, requested: item.qtyBase },
          );
        }

        const updated = await tx.batch.update({
          where: { id: batch.id },
          data: { qtyOnHand: { decrement: item.qtyBase } },
          select: { qtyOnHand: true },
        });
        if (updated.qtyOnHand === 0) {
          await tx.batch.update({ where: { id: batch.id }, data: { status: 'DEPLETED' } });
        }

        await tx.stockMovement.create({
          data: {
            branchId,
            productId: item.productId,
            batchId: batch.id,
            qtyDelta: -item.qtyBase,
            type: 'TRANSFER_OUT',
            refType: 'stock_transfer',
            refId: id,
            unitCost: item.unitCost,
            performedBy: actor.id,
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: 'IN_TRANSIT', dispatchedBy: actor.id, dispatchedAt: new Date() },
      });

      // Tell the receiving branch something is on its way. Notifications are
      // branch-tagged rather than branch-scoped, so addressing one to the other
      // branch is permitted by design — no escape hatch needed.
      await tx.notification.create({
        data: {
          id: uuid(),
          branchId: transfer.toBranchId,
          type: 'TRANSFER_INCOMING',
          payload: {
            transferId: id,
            transferNumber: transfer.transferNumber,
            fromBranchId: branchId,
            lines: transfer.items.length,
          },
        },
      });
    });

    await this.audit.log({
      userId: actor.id,
      action: 'transfer.dispatch',
      entity: 'stock_transfer',
      entityId: id,
      after: { status: 'IN_TRANSIT' },
    });
    return this.get(id, actor);
  }

  /**
   * Goods arrive. Quantities default to what was sent, but a short receipt is
   * normal — the shortfall stays visible on the transfer rather than being
   * silently written off, so a manager can chase it.
   */
  async receive(id: string, dto: ReceiveTransferDto, actor: RequestUser) {
    const branchId = this.actorBranch(actor, 'receive a transfer');

    await this.prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findFirst({
        where: { id, toBranchId: branchId },
        include: { items: true },
      });
      if (!transfer) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found for this branch' });
      }
      if (transfer.status !== 'IN_TRANSIT') {
        throw new DomainException('TRANSFER_NOT_IN_TRANSIT', `Cannot receive a ${transfer.status} transfer`);
      }

      const declared = new Map((dto.items ?? []).map((i) => [i.itemId, i.qtyReceived]));

      for (const item of transfer.items) {
        const qty = declared.has(item.id) ? declared.get(item.id)! : item.qtyBase;
        if (qty > item.qtyBase) {
          throw new DomainException(
            'RECEIVED_EXCEEDS_SENT',
            `Cannot receive ${qty} of a line that only sent ${item.qtyBase}`,
            { itemId: item.id },
          );
        }
        if (qty === 0) continue;

        // Land in a batch of the same identity at this branch, creating it on
        // first arrival. unit_cost travels with the goods so valuation follows.
        const existing = await tx.batch.findFirst({
          where: {
            productId: item.productId,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
          },
        });

        let destBatchId: string;
        if (existing) {
          const newQty = existing.qtyOnHand + qty;
          const newCost =
            existing.qtyOnHand > 0
              ? existing.unitCost
                  .mul(existing.qtyOnHand)
                  .add(item.unitCost.mul(qty))
                  .div(newQty)
              : item.unitCost;
          await tx.batch.update({
            where: { id: existing.id },
            data: { qtyOnHand: newQty, unitCost: newCost, status: 'ACTIVE' },
          });
          destBatchId = existing.id;
        } else {
          destBatchId = uuid();
          await tx.batch.create({
            data: {
              id: destBatchId,
              branchId,
              productId: item.productId,
              batchNumber: item.batchNumber,
              expiryDate: item.expiryDate,
              qtyOnHand: qty,
              unitCost: item.unitCost,
              status: 'ACTIVE',
            },
          });
        }

        await tx.stockMovement.create({
          data: {
            branchId,
            productId: item.productId,
            batchId: destBatchId,
            qtyDelta: qty,
            type: 'TRANSFER_IN',
            refType: 'stock_transfer',
            refId: id,
            unitCost: item.unitCost,
            performedBy: actor.id,
          },
        });

        await tx.stockTransferItem.update({
          where: { id: item.id },
          data: { qtyReceived: qty, destBatchId },
        });
      }

      await tx.stockTransfer.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedBy: actor.id,
          receivedAt: new Date(),
          ...(dto.notes ? { notes: [transfer.notes, `[receipt] ${dto.notes}`].filter(Boolean).join(' — ') } : {}),
        },
      });

      // Any shortfall is a real-world discrepancy — raise it at the sending
      // branch, which is the side still carrying the value.
      const short = transfer.items.filter(
        (i) => (declared.has(i.id) ? declared.get(i.id)! : i.qtyBase) < i.qtyBase,
      );
      if (short.length > 0) {
        await tx.notification.create({
          data: {
            id: uuid(),
            branchId: transfer.fromBranchId,
            type: 'TRANSFER_SHORT_RECEIPT',
            payload: {
              transferId: id,
              transferNumber: transfer.transferNumber,
              lines: short.map((i) => ({
                itemId: i.id,
                sent: i.qtyBase,
                received: declared.has(i.id) ? declared.get(i.id)! : i.qtyBase,
              })),
            },
          },
        });
      }
    });

    await this.audit.log({
      userId: actor.id,
      action: 'transfer.receive',
      entity: 'stock_transfer',
      entityId: id,
      after: { status: 'RECEIVED' },
    });
    return this.get(id, actor);
  }

  /** Only a draft can be cancelled — once goods are moving, they must be received. */
  async cancel(id: string, actor: RequestUser) {
    const branchId = this.actorBranch(actor, 'cancel a transfer');
    const transfer = await this.prisma.stockTransfer.findFirst({
      where: { id, fromBranchId: branchId },
    });
    if (!transfer) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found for this branch' });
    }
    if (transfer.status !== 'DRAFT') {
      throw new DomainException(
        'TRANSFER_NOT_DRAFT',
        'Goods are already in transit — receive them at the destination instead',
      );
    }
    await this.prisma.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log({
      userId: actor.id,
      action: 'transfer.cancel',
      entity: 'stock_transfer',
      entityId: id,
    });
    return this.get(id, actor);
  }

  /** Dispatched but unreceived value, still carried by the sending branch. */
  async inTransit(actor: RequestUser) {
    const branchId = actor.branchId;
    const rows = await this.prisma.$queryRaw<
      {
        transfer_number: string;
        from_branch_code: string;
        to_branch_code: string;
        product_name: string;
        qty_base: number;
        value_in_transit: Prisma.Decimal;
        dispatched_at: Date;
      }[]
    >`
      SELECT transfer_number, from_branch_code, to_branch_code,
             product_name, qty_base, value_in_transit, dispatched_at
      FROM v_in_transit
      ${branchId ? Prisma.sql`WHERE from_branch_id = ${branchId}::uuid OR to_branch_id = ${branchId}::uuid` : Prisma.empty}
      ORDER BY dispatched_at`;

    const data = rows.map((r) => ({
      transferNumber: r.transfer_number,
      fromBranchCode: r.from_branch_code,
      toBranchCode: r.to_branch_code,
      productName: r.product_name,
      qtyBase: Number(r.qty_base),
      valueInTransit: r.value_in_transit,
      dispatchedAt: r.dispatched_at,
    }));
    return {
      rows: data,
      totalValue: data.reduce((s, r) => s + Number(r.valueInTransit), 0).toFixed(2),
    };
  }

  private serialize(t: Prisma.StockTransferGetPayload<{ include: typeof transferInclude }>) {
    return {
      id: t.id,
      transferNumber: t.transferNumber,
      fromBranchId: t.fromBranchId,
      fromBranchCode: t.fromBranch.code,
      toBranchId: t.toBranchId,
      toBranchCode: t.toBranch.code,
      status: t.status,
      notes: t.notes,
      dispatchedAt: t.dispatchedAt,
      receivedAt: t.receivedAt,
      createdAt: t.createdAt,
      items: t.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.product.name,
        baseUnit: i.product.baseUnit,
        batchNumber: i.batchNumber,
        expiryDate: i.expiryDate.toISOString().slice(0, 10),
        qtyBase: i.qtyBase,
        qtyReceived: i.qtyReceived,
        unitCost: i.unitCost,
      })),
    };
  }
}
