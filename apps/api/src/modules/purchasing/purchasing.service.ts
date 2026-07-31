import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { listEnvelope } from '../../common/pagination';
import { CreatePoDto, CreateReceiptDto, FromSuggestionsDto } from './dto';
import type { RequestUser } from '../../common/jwt-auth.guard';

const poInclude = {
  supplier: { select: { name: true } },
  items: { include: { product: { select: { name: true, baseUnit: true } } } },
} satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Purchase orders ────────────────────────────────────────────────────────

  async listPos(opts: { page: number; pageSize: number; status?: string; supplierId?: string }) {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(opts.status ? { status: opts.status as Prisma.PurchaseOrderWhereInput['status'] } : {}),
      ...(opts.supplierId ? { supplierId: opts.supplierId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        include: poInclude,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return listEnvelope(rows.map((po) => this.serializePo(po)), opts.page, opts.pageSize, total);
  }

  async getPo(id: string) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id }, include: poInclude });
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found' });
    return this.serializePo(po);
  }

  async createPo(dto: CreatePoDto, actor: RequestUser) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, deletedAt: null },
    });
    if (!supplier) throw new DomainException('SUPPLIER_UNKNOWN', 'Supplier not found');

    const productIds = dto.items.map((i) => i.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw new DomainException('DUPLICATE_PO_LINE', 'A product appears twice on the order');
    }
    const count = await this.prisma.product.count({
      where: { id: { in: productIds }, deletedAt: null },
    });
    if (count !== productIds.length) {
      throw new DomainException('PRODUCT_UNKNOWN', 'One or more products do not exist');
    }

    const branchId = this.actorBranch(actor, 'raise a purchase order');

    const id = uuid();
    await this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { code: true },
      });
      const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('po_number_seq')`;
      await tx.purchaseOrder.create({
        data: {
          id,
          poNumber: `${branch.code}-PO-${new Date().getFullYear()}-${String(nextval).padStart(4, '0')}`,
          branchId,
          supplierId: dto.supplierId,
          expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          notes: dto.notes ?? null,
          createdBy: actor.id,
        },
      });
      for (const item of dto.items) {
        await tx.purchaseOrderItem.create({
          data: {
            id: uuid(),
            poId: id,
            productId: item.productId,
            qtyBase: item.qtyBase,
            unitCost: new Prisma.Decimal(item.unitCost),
          },
        });
      }
    });

    await this.audit.log({
      userId: actor.id,
      action: 'po.create',
      entity: 'purchase_order',
      entityId: id,
      after: { supplier: supplier.name, lines: dto.items.length },
    });
    return this.getPo(id);
  }

  /** Draft a PO from the low-stock list (US-10 AC2). */
  async fromSuggestions(dto: FromSuggestionsDto, actor: RequestUser) {
    // A branch orders for its own shelves — v_low_stock carries a row per
    // branch × product since ADR-010, so this must be filtered explicitly.
    const suggestBranch = this.actorBranch(actor, 'draft an order from suggestions');
    const low = await this.prisma.$queryRaw<
      { product_id: string; qty_base: bigint; reorder_level: number }[]
    >`SELECT product_id, qty_base, reorder_level
      FROM v_low_stock
      WHERE branch_id = ${suggestBranch}::uuid`;

    const wanted = dto.productIds?.length
      ? low.filter((r) => dto.productIds!.includes(r.product_id))
      : low;
    if (wanted.length === 0) {
      throw new DomainException('NOTHING_TO_ORDER', 'No low-stock products to draft from');
    }

    // qty: back up to twice the reorder level; cost: latest batch cost on file
    const items = [];
    for (const r of wanted) {
      const lastBatch = await this.prisma.batch.findFirst({
        where: { productId: r.product_id },
        orderBy: { createdAt: 'desc' },
        select: { unitCost: true },
      });
      items.push({
        productId: r.product_id,
        qtyBase: Math.max(r.reorder_level * 2 - Number(r.qty_base), r.reorder_level, 1),
        unitCost: (lastBatch?.unitCost ?? new Prisma.Decimal(0)).toString(),
      });
    }

    return this.createPo(
      { supplierId: dto.supplierId, items, notes: 'Drafted from low-stock suggestions' },
      actor,
    );
  }

  async sendPo(id: string, actor: RequestUser) {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Purchase order not found' });
    if (po.status !== 'DRAFT') {
      throw new DomainException('PO_NOT_DRAFT', `Only DRAFT orders can be sent (is ${po.status})`);
    }
    await this.prisma.purchaseOrder.update({ where: { id }, data: { status: 'SENT' } });
    await this.audit.log({
      userId: actor.id,
      action: 'po.send',
      entity: 'purchase_order',
      entityId: id,
    });
    return this.getPo(id);
  }

  // ── Goods receipts (US-09) ─────────────────────────────────────────────────

  /**
   * One transaction: GRN → per line create-or-top-up the batch (weighted-average
   * cost) → RECEIPT movement → PO progress. Over-receipt needs the manager flag.
   */
  async receive(dto: CreateReceiptDto, actor: RequestUser) {
    const branchId = this.actorBranch(actor, 'receive goods');

    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, deletedAt: null },
    });
    if (!supplier) throw new DomainException('SUPPLIER_UNKNOWN', 'Supplier not found');

    const grnId = await this.prisma.$transaction(async (tx) => {
      let po = null;
      if (dto.poId) {
        po = await tx.purchaseOrder.findUnique({
          where: { id: dto.poId },
          include: { items: true },
        });
        if (!po) throw new DomainException('PO_UNKNOWN', 'Purchase order not found');
        if (po.status === 'CANCELLED' || po.status === 'CLOSED') {
          throw new DomainException('PO_NOT_OPEN', `Cannot receive against a ${po.status} order`);
        }
      }

      // Goods must be received where the order was raised, or stock lands at
      // the wrong shop and the PO never reconciles (ADR-010).
      if (po && po.branchId !== branchId) {
        throw new DomainException(
          'PO_BRANCH_MISMATCH',
          'That order was raised for a different branch',
          { poBranchId: po.branchId },
        );
      }

      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { code: true },
      });
      const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('grn_number_seq')`;
      const grnId = uuid();
      await tx.goodsReceipt.create({
        data: {
          id: grnId,
          grnNumber: `${branch.code}-GRN-${new Date().getFullYear()}-${String(nextval).padStart(4, '0')}`,
          branchId,
          poId: dto.poId ?? null,
          supplierId: dto.supplierId,
          receivedBy: actor.id,
          notes: dto.notes ?? null,
        },
      });

      for (const item of dto.items) {
        const product = await tx.product.findFirst({
          where: { id: item.productId, deletedAt: null },
        });
        if (!product) {
          throw new DomainException('PRODUCT_UNKNOWN', `Product ${item.productId} not found`);
        }
        const expiry = new Date(item.expiryDate);
        if (expiry <= new Date()) {
          throw new DomainException('EXPIRED_ON_ARRIVAL', `${product.name}: batch is already expired`, {
            productId: item.productId,
            expiryDate: item.expiryDate,
          });
        }

        // PO progress + over-receipt guard
        if (po) {
          const poItem = po.items.find((i) => i.productId === item.productId);
          if (!poItem) {
            throw new DomainException('NOT_ON_PO', `${product.name} is not on ${po.poNumber}`, {
              productId: item.productId,
            });
          }
          if (poItem.qtyReceived + item.qtyBase > poItem.qtyBase && !dto.allowOverReceipt) {
            throw new DomainException(
              'OVER_RECEIPT',
              `${product.name}: receiving ${poItem.qtyReceived + item.qtyBase} of ${poItem.qtyBase} ordered needs Manager approval`,
              { productId: item.productId, ordered: poItem.qtyBase, received: poItem.qtyReceived },
            );
          }
          await tx.purchaseOrderItem.update({
            where: { id: poItem.id },
            data: { qtyReceived: { increment: item.qtyBase } },
          });
        }

        // Create or top up the batch; weighted-average cost (ADR-004 note)
        const inCost = new Prisma.Decimal(item.unitCost);
        const existing = await tx.batch.findUnique({
          where: {
            branchId_productId_batchNumber_expiryDate: {
              branchId,
              productId: item.productId,
              batchNumber: item.batchNumber,
              expiryDate: expiry,
            },
          },
        });

        let batchId: string;
        if (existing) {
          const oldQty = existing.qtyOnHand;
          const newQty = oldQty + item.qtyBase;
          const newCost =
            oldQty > 0
              ? existing.unitCost.mul(oldQty).add(inCost.mul(item.qtyBase)).div(newQty)
              : inCost;
          await tx.batch.update({
            where: { id: existing.id },
            data: {
              qtyOnHand: newQty,
              unitCost: newCost,
              status: newQty > 0 ? 'ACTIVE' : existing.status,
            },
          });
          batchId = existing.id;
        } else {
          batchId = uuid();
          await tx.batch.create({
            data: {
              id: batchId,
              branchId,
              productId: item.productId,
              batchNumber: item.batchNumber,
              expiryDate: expiry,
              qtyOnHand: item.qtyBase,
              unitCost: inCost,
              status: 'ACTIVE',
            },
          });
        }

        await tx.goodsReceiptItem.create({
          data: {
            id: uuid(),
            receiptId: grnId,
            productId: item.productId,
            batchId,
            qtyBase: item.qtyBase,
            unitCost: inCost,
          },
        });

        await tx.stockMovement.create({
          data: {
            branchId,
            productId: item.productId,
            batchId,
            qtyDelta: item.qtyBase,
            type: 'RECEIPT',
            refType: 'goods_receipt',
            refId: grnId,
            unitCost: inCost,
            performedBy: actor.id,
          },
        });
      }

      // Recompute PO status after all lines land
      if (po) {
        const fresh = await tx.purchaseOrderItem.findMany({ where: { poId: po.id } });
        const complete = fresh.every((i) => i.qtyReceived >= i.qtyBase);
        const any = fresh.some((i) => i.qtyReceived > 0);
        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: complete ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : po.status },
        });
      }

      return grnId;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'goods_receipt.create',
      entity: 'goods_receipt',
      entityId: grnId,
      after: { supplier: supplier.name, lines: dto.items.length, poId: dto.poId ?? null },
    });
    return this.getReceipt(grnId);
  }

  async getReceipt(id: string) {
    const grn = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        supplier: { select: { name: true } },
        po: { select: { poNumber: true } },
        items: {
          include: {
            product: { select: { name: true, baseUnit: true } },
            batch: { select: { batchNumber: true, expiryDate: true, qtyOnHand: true, unitCost: true } },
          },
        },
      },
    });
    if (!grn) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Goods receipt not found' });
    return {
      id: grn.id,
      grnNumber: grn.grnNumber,
      poNumber: grn.po?.poNumber ?? null,
      supplierName: grn.supplier.name,
      receivedAt: grn.receivedAt,
      notes: grn.notes,
      items: grn.items.map((i) => ({
        productId: i.productId,
        productName: i.product.name,
        baseUnit: i.product.baseUnit,
        qtyBase: i.qtyBase,
        unitCost: i.unitCost,
        batchNumber: i.batch.batchNumber,
        expiryDate: i.batch.expiryDate.toISOString().slice(0, 10),
      })),
    };
  }

  async listReceipts(opts: { page: number; pageSize: number; poId?: string }) {
    const where = opts.poId ? { poId: opts.poId } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.goodsReceipt.findMany({
        where,
        include: { supplier: { select: { name: true } }, po: { select: { poNumber: true } } },
        orderBy: { receivedAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return listEnvelope(
      rows.map((r) => ({
        id: r.id,
        grnNumber: r.grnNumber,
        poNumber: r.po?.poNumber ?? null,
        supplierName: r.supplier.name,
        receivedAt: r.receivedAt,
      })),
      opts.page,
      opts.pageSize,
      total,
    );
  }

  /** Stock always lands at one shop, so these actions need an active branch. */
  private actorBranch(actor: RequestUser, action: string): string {
    if (!actor.branchId) {
      throw new DomainException('BRANCH_REQUIRED', `Select a branch to ${action}`);
    }
    return actor.branchId;
  }

  private serializePo(po: Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>) {
    return {
      id: po.id,
      poNumber: po.poNumber,
      supplierId: po.supplierId,
      supplierName: po.supplier.name,
      status: po.status,
      expectedDate: po.expectedDate?.toISOString().slice(0, 10) ?? null,
      notes: po.notes,
      createdAt: po.createdAt,
      items: po.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.product.name,
        baseUnit: i.product.baseUnit,
        qtyBase: i.qtyBase,
        qtyReceived: i.qtyReceived,
        unitCost: i.unitCost,
      })),
    };
  }
}
