import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../../common/domain.exception';
import { fromPesewas, toPesewas, vatPortion } from '../../common/money';
import { listEnvelope } from '../../common/pagination';
import { SaleCreateDto, SaleItemDto } from './dto';
import type { RequestUser } from '../../common/jwt-auth.guard';

interface LockedBatch {
  id: string;
  qty_on_hand: number;
  unit_cost: Prisma.Decimal;
  expiry_date: Date;
}

interface Allocation {
  batchId: string;
  qty: number;
  unitCost: Prisma.Decimal;
}

export interface CreateSaleResult {
  sale: Awaited<ReturnType<SalesService['getSale']>>;
  duplicate: boolean;
}

const saleInclude = {
  items: {
    include: {
      product: { select: { name: true, baseUnit: true } },
      unit: { select: { unitName: true } },
      batch: { select: { batchNumber: true, expiryDate: true } },
    },
  },
  payments: true,
  cashier: { select: { fullName: true } },
} satisfies Prisma.SaleInclude;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One DB transaction: FEFO batch selection with FOR UPDATE → movements →
   * batch totals → sale + items + payments (api-schema.md §Cross-cutting, NFR-05).
   *
   * `offline` = arrived via the sync queue (ADR-006): money was already taken at
   * the till, so insufficient stock records the sale anyway, drives the batch
   * negative, and raises a NEG_STOCK_EXCEPTION notification instead of failing.
   */
  async createSale(dto: SaleCreateDto, actor: RequestUser, offline = false): Promise<CreateSaleResult> {
    const branchId = this.actorBranch(actor);

    const existing = await this.prisma.sale.findUnique({ where: { clientSaleId: dto.clientSaleId } });
    if (existing) {
      return { sale: await this.getSale(existing.id, actor), duplicate: true };
    }

    const vatRate = await this.vatRate();

    const saleId = await this.prisma.$transaction(async (tx) => {
      // ── Load & validate products/units ────────────────────────────────────
      const productIds = [...new Set(dto.items.map((i) => i.productId))];
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        include: { units: true },
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      interface Line {
        item: SaleItemDto;
        product: (typeof products)[number];
        unit: { id: string; unitName: string; factorToBase: number } | null;
        qtyBase: number;
        grossP: number; // pesewas
        discountP: number;
        lineTotalP: number;
        vatP: number;
        allocations: Allocation[];
      }

      const lines: Line[] = [];
      for (const item of dto.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          throw new DomainException('PRODUCT_UNKNOWN', `Product ${item.productId} not found`, {
            productId: item.productId,
          });
        }
        let unit: Line['unit'] = null;
        let factor = 1;
        if (item.productUnitId) {
          const u = product.units.find((x) => x.id === item.productUnitId);
          if (!u) {
            throw new DomainException('UNIT_MISMATCH', 'Unit does not belong to this product', {
              productUnitId: item.productUnitId,
            });
          }
          unit = { id: u.id, unitName: u.unitName, factorToBase: u.factorToBase };
          factor = u.factorToBase;
        }

        const priceP = toPesewas(item.unitPrice);
        const discountP = toPesewas(item.discount ?? 0);
        if (priceP < 0 || discountP < 0) {
          throw new DomainException('NEGATIVE_AMOUNT', 'Price/discount cannot be negative');
        }
        // Discounts are role-gated (wireframes §Keyboard shortcuts, F8):
        // cashiers ring full price; a Pharmacist/Manager applies reductions.
        if (discountP > 0 && actor.role === 'CASHIER') {
          throw new DomainException('DISCOUNT_FORBIDDEN', 'Discounts need a Pharmacist or Manager');
        }
        const grossP = priceP * item.quantity;
        const lineTotalP = grossP - discountP;
        if (lineTotalP < 0) {
          throw new DomainException('DISCOUNT_EXCEEDS_LINE', 'Discount larger than line amount');
        }

        lines.push({
          item,
          product,
          unit,
          qtyBase: item.quantity * factor,
          grossP,
          discountP,
          lineTotalP,
          vatP: product.vatApplies ? vatPortion(lineTotalP, vatRate) : 0,
          allocations: [],
        });
      }

      // ── Totals & payment check ────────────────────────────────────────────
      const subtotalP = lines.reduce((s, l) => s + l.grossP, 0);
      const discountTotalP = lines.reduce((s, l) => s + l.discountP, 0);
      const vatTotalP = lines.reduce((s, l) => s + l.vatP, 0);
      const totalP = subtotalP - discountTotalP;

      const paidP = dto.payments.reduce((s, p) => s + toPesewas(p.amount), 0);
      if (paidP !== totalP) {
        throw new DomainException('PAYMENT_MISMATCH', 'Payments do not add up to the sale total', {
          total: fromPesewas(totalP),
          paid: fromPesewas(paidP),
        });
      }

      // ── FEFO allocation under row locks ───────────────────────────────────
      // Aggregate demand per product so two lines of the same product can't
      // both take the same stock.
      const demand = new Map<string, number>();
      for (const l of lines) demand.set(l.product.id, (demand.get(l.product.id) ?? 0) + l.qtyBase);

      const available = new Map<string, LockedBatch[]>();
      for (const productId of demand.keys()) {
        // Raw SQL is invisible to the branch-scope extension — the branch_id
        // predicate here is what stops one till selling another branch's stock.
        const batches = await tx.$queryRaw<LockedBatch[]>`
          SELECT id, qty_on_hand, unit_cost, expiry_date
          FROM batches
          WHERE branch_id = ${branchId}::uuid
            AND product_id = ${productId}::uuid
            AND status = 'ACTIVE'
            AND expiry_date > CURRENT_DATE
            AND qty_on_hand > 0
          ORDER BY expiry_date ASC, created_at ASC
          FOR UPDATE`;
        available.set(productId, batches);
      }

      for (const line of lines) {
        let remaining = line.qtyBase;
        const batches = available.get(line.product.id)!;
        for (const b of batches) {
          if (remaining === 0) break;
          if (b.qty_on_hand === 0) continue;
          const take = Math.min(b.qty_on_hand, remaining);
          line.allocations.push({ batchId: b.id, qty: take, unitCost: b.unit_cost });
          b.qty_on_hand -= take;
          remaining -= take;
        }

        if (remaining > 0) {
          if (!offline) {
            // Distinguish "it's all expired" from "there just isn't enough"
            const expiredStock = await tx.batch.count({
              where: {
                branchId,
                productId: line.product.id,
                qtyOnHand: { gt: 0 },
                OR: [{ status: 'EXPIRED' }, { expiryDate: { lte: new Date() } }],
              },
            });
            if (expiredStock > 0) {
              throw new DomainException('BATCH_EXPIRED', `${line.product.name}: remaining stock is expired`, {
                productId: line.product.id,
              });
            }
            throw new DomainException('INSUFFICIENT_STOCK', `${line.product.name}: not enough stock`, {
              productId: line.product.id,
              requested: line.qtyBase,
              short: remaining,
            });
          }

          // Offline sync: drive the FEFO-last batch negative (ADR-006) and
          // surface a Manager exception rather than blocking the sync.
          const fallback =
            line.allocations[line.allocations.length - 1]?.batchId ??
            (
              await tx.batch.findFirst({
                where: { branchId, productId: line.product.id },
                orderBy: { createdAt: 'desc' },
                select: { id: true },
              })
            )?.id;
          if (!fallback) {
            throw new DomainException('NO_BATCH', `${line.product.name}: no batch exists to record against`, {
              productId: line.product.id,
            });
          }
          const fb = line.allocations.find((a) => a.batchId === fallback);
          if (fb) fb.qty += remaining;
          else line.allocations.push({ batchId: fallback, qty: remaining, unitCost: new Prisma.Decimal(0) });

          await tx.notification.create({
            data: {
              id: uuid(),
              branchId,
              type: 'NEG_STOCK_EXCEPTION',
              payload: {
                productId: line.product.id,
                productName: line.product.name,
                clientSaleId: dto.clientSaleId,
                qtyShort: remaining,
              },
            },
          });
        }
      }

      // ── Receipt number ────────────────────────────────────────────────────
      // One global sequence, branch-code prefixed (ADR-010): receipt numbers
      // stay globally unique — which the offline dedupe relies on — while
      // still reading as belonging to a branch.
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { code: true },
      });
      const [{ nextval }] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('receipt_number_seq')`;
      const receiptNumber = `${branch.code}-RCP-${new Date().getFullYear()}-${String(nextval).padStart(6, '0')}`;

      // ── Persist sale, items, movements, batch totals, payments ───────────
      const saleId = uuid();
      await tx.sale.create({
        data: {
          id: saleId,
          branchId,
          clientSaleId: dto.clientSaleId,
          receiptNumber,
          cashierId: actor.id,
          customerId: dto.customerId ?? null,
          subtotal: fromPesewas(subtotalP),
          discountTotal: fromPesewas(discountTotalP),
          vatTotal: fromPesewas(vatTotalP),
          total: fromPesewas(totalP),
          syncedOffline: offline,
          soldAt: new Date(dto.soldAt),
        },
      });

      for (const line of lines) {
        // A line may span batches (FEFO split) — one sale_item per allocation.
        // Line-level money is attached to the first split; the rest carry 0 so
        // receipt totals stay exact.
        let first = true;
        for (const alloc of line.allocations) {
          const qtyInUnit = first ? line.item.quantity : 0;
          await tx.saleItem.create({
            data: {
              id: uuid(),
              saleId,
              productId: line.product.id,
              productUnitId: line.unit?.id ?? null,
              batchId: alloc.batchId,
              quantity: qtyInUnit > 0 ? qtyInUnit : Math.max(1, alloc.qty),
              qtyBase: alloc.qty,
              unitPrice: first ? fromPesewas(toPesewas(line.item.unitPrice)) : new Prisma.Decimal(0),
              discount: first ? fromPesewas(line.discountP) : new Prisma.Decimal(0),
              lineTotal: first ? fromPesewas(line.lineTotalP) : new Prisma.Decimal(0),
            },
          });

          await tx.stockMovement.create({
            data: {
              branchId,
              productId: line.product.id,
              batchId: alloc.batchId,
              qtyDelta: -alloc.qty,
              type: 'SALE',
              refType: 'sale',
              refId: saleId,
              unitCost: alloc.unitCost,
              performedBy: actor.id,
            },
          });

          const updated = await tx.batch.update({
            where: { id: alloc.batchId },
            data: { qtyOnHand: { decrement: alloc.qty } },
            select: { qtyOnHand: true },
          });
          if (updated.qtyOnHand === 0) {
            await tx.batch.update({ where: { id: alloc.batchId }, data: { status: 'DEPLETED' } });
          }
          first = false;
        }
      }

      for (const p of dto.payments) {
        const amountP = toPesewas(p.amount);
        const tenderedP = p.tendered !== undefined ? toPesewas(p.tendered) : null;
        if (tenderedP !== null && tenderedP < amountP) {
          throw new DomainException('TENDERED_TOO_LOW', 'Amount tendered is below the amount due');
        }
        await tx.payment.create({
          data: {
            id: uuid(),
            saleId,
            method: p.method,
            amount: fromPesewas(amountP),
            tendered: tenderedP !== null ? fromPesewas(tenderedP) : null,
            changeDue: tenderedP !== null ? fromPesewas(tenderedP - amountP) : null,
            momoRef: p.momoRef ?? null,
          },
        });
      }

      return saleId;
    });

    await this.audit.log({
      userId: actor.id,
      action: 'sale.create',
      entity: 'sale',
      entityId: saleId,
      after: { clientSaleId: dto.clientSaleId, offline },
    });

    return { sale: await this.getSale(saleId, actor), duplicate: false };
  }

  async syncSales(sales: SaleCreateDto[], actor: RequestUser) {
    const results = [];
    for (const s of sales) {
      // A sale queued at one branch must never post against another (ADR-010).
      // The till already took the money, so this is quarantined for a manager,
      // not dropped — the client leaves it queued on a non-ok status.
      if (s.branchId && s.branchId !== actor.branchId) {
        await this.prisma.notification.create({
          data: {
            id: uuid(),
            branchId: s.branchId,
            type: 'SYNC_BRANCH_MISMATCH',
            payload: {
              clientSaleId: s.clientSaleId,
              queuedAtBranch: s.branchId,
              postedFromBranch: actor.branchId,
            },
          },
        });
        results.push({
          clientSaleId: s.clientSaleId,
          status: 'error' as const,
          error: 'BRANCH_MISMATCH: sale was taken at a different branch',
        });
        continue;
      }
      try {
        const { sale, duplicate } = await this.createSale(s, actor, true);
        results.push({
          clientSaleId: s.clientSaleId,
          status: duplicate ? ('duplicate' as const) : ('created' as const),
          receiptNumber: sale.receiptNumber,
        });
      } catch (err) {
        results.push({
          clientSaleId: s.clientSaleId,
          status: 'error' as const,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
    return { results };
  }

  async getSale(id: string, actor: RequestUser) {
    const sale = await this.prisma.sale.findUnique({ where: { id }, include: saleInclude });
    if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    this.assertCanView(sale, actor);
    return this.serialize(sale);
  }

  async listSales(
    actor: RequestUser,
    opts: { page: number; pageSize: number; from?: string; to?: string; cashierId?: string; q?: string },
  ) {
    const where: Prisma.SaleWhereInput = {
      ...(opts.q ? { receiptNumber: { contains: opts.q, mode: 'insensitive' } } : {}),
      ...(opts.cashierId ? { cashierId: opts.cashierId } : {}),
      ...(opts.from || opts.to
        ? {
            soldAt: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    // Cashiers see their own sales, today only (api-schema.md)
    if (actor.role === 'CASHIER') {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      where.cashierId = actor.id;
      where.soldAt = { gte: dayStart };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        include: saleInclude,
        orderBy: { soldAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.sale.count({ where }),
    ]);
    return listEnvelope(rows.map((s) => this.serialize(s)), opts.page, opts.pageSize, total);
  }

  /** Print-ready payload; reprints are flagged and audited (US-07 AC2). */
  async receipt(id: string, actor: RequestUser, reprint: boolean) {
    const sale = await this.getSale(id, actor);
    const header = (await this.prisma.setting.findUnique({ where: { key: 'receipt_header' } }))?.value ?? {};
    if (reprint) {
      await this.audit.log({
        userId: actor.id,
        action: 'sale.receipt_reprint',
        entity: 'sale',
        entityId: id,
      });
    }
    return { header, sale, reprint };
  }

  /** Void with compensating stock movements — Manager+ only, audited. */
  async voidSale(id: string, reason: string, actor: RequestUser) {
    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id }, include: { items: true } });
      if (!sale) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
      if (sale.status === 'VOIDED') {
        throw new DomainException('ALREADY_VOIDED', 'Sale is already voided');
      }

      for (const item of sale.items) {
        await tx.stockMovement.create({
          data: {
            branchId: sale.branchId,
            productId: item.productId,
            batchId: item.batchId,
            qtyDelta: item.qtyBase,
            type: 'RETURN_IN',
            refType: 'sale_void',
            refId: sale.id,
            performedBy: actor.id,
          },
        });
        await tx.batch.update({
          where: { id: item.batchId },
          data: { qtyOnHand: { increment: item.qtyBase }, status: 'ACTIVE' },
        });
      }

      await tx.sale.update({ where: { id }, data: { status: 'VOIDED' } });
      await this.audit.log(
        {
          userId: actor.id,
          action: 'sale.void',
          entity: 'sale',
          entityId: id,
          before: { status: 'COMPLETED' },
          after: { status: 'VOIDED', reason },
        },
        tx,
      );
    });
    return this.getSale(id, actor);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async vatRate(): Promise<number> {
    const setting = await this.prisma.setting.findUnique({ where: { key: 'vat_rate' } });
    const rate = Number(setting?.value ?? 0);
    return Number.isFinite(rate) && rate >= 0 ? rate : 0;
  }

  /**
   * A sale is always taken at one till in one branch, so consolidated
   * (all-branch) mode cannot ring one up.
   */
  private actorBranch(actor: RequestUser): string {
    if (!actor.branchId) {
      throw new DomainException(
        'BRANCH_REQUIRED',
        'Select a branch before taking a sale',
      );
    }
    return actor.branchId;
  }

  private assertCanView(sale: { cashierId: string; soldAt: Date; branchId: string }, actor: RequestUser) {
    // Branch first: a Manager at one branch has no business reading another's
    // sales, whatever their role allows locally.
    if (actor.branchId && sale.branchId !== actor.branchId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    }
    if (actor.role !== 'CASHIER') return;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    if (sale.cashierId !== actor.id || sale.soldAt < dayStart) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    }
  }

  private serialize(sale: Prisma.SaleGetPayload<{ include: typeof saleInclude }>) {
    return {
      id: sale.id,
      clientSaleId: sale.clientSaleId,
      receiptNumber: sale.receiptNumber,
      cashierId: sale.cashierId,
      cashierName: sale.cashier.fullName,
      status: sale.status,
      subtotal: sale.subtotal,
      discountTotal: sale.discountTotal,
      vatTotal: sale.vatTotal,
      total: sale.total,
      soldAt: sale.soldAt,
      syncedOffline: sale.syncedOffline,
      items: sale.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.product.name,
        productUnitId: i.productUnitId,
        unitName: i.unit?.unitName ?? i.product.baseUnit,
        batchNumber: i.batch.batchNumber,
        quantity: i.quantity,
        qtyBase: i.qtyBase,
        unitPrice: i.unitPrice,
        discount: i.discount,
        lineTotal: i.lineTotal,
      })),
      payments: sale.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        tendered: p.tendered,
        changeDue: p.changeDue,
      })),
    };
  }
}
