import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainException } from '../../common/domain.exception';

/** Interpolated raw, so kept to a closed set — never a caller-supplied string. */
type BranchColumn = 'branch_id' | 's.branch_id' | 'sa.branch_id';

interface StockValuationRow {
  product_id: string;
  name: string;
  base_unit: string;
  qty_base: bigint;
  value_at_cost: Prisma.Decimal;
  reorder_level: number;
}

export type SalesGroupBy = 'product' | 'category' | 'day';

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reports read views and hand-written SQL, both invisible to the branch-scope
   * Prisma extension (ADR-010), so every query below carries its own branch
   * predicate. A null branchId is consolidated all-branch mode — ADMIN only,
   * enforced at the token, so reaching here with null is already authorised.
   */
  private branchFilter(branchId: string | null, column: BranchColumn) {
    // `column` is Prisma.raw, so it is deliberately typed as a closed union of
    // literals — it must never take a caller-supplied string. The branch id
    // itself stays a bound parameter.
    return branchId
      ? Prisma.sql`AND ${Prisma.raw(column)} = ${branchId}::uuid`
      : Prisma.empty;
  }

  /** US-13: sales grouped by product / category / day over a range. */
  async salesReport(from: Date, to: Date, groupBy: SalesGroupBy, branchId: string | null) {
    const branch = this.branchFilter(branchId, 's.branch_id');

    if (groupBy === 'day') {
      const rows = await this.prisma.$queryRaw<
        { key: Date; gross: Prisma.Decimal; receipts: bigint; qty: bigint }[]
      >`
        SELECT s.sold_at::date AS key, SUM(si.line_total) AS gross,
               COUNT(DISTINCT s.id) AS receipts, SUM(si.qty_base) AS qty
        FROM sales s JOIN sale_items si ON si.sale_id = s.id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= ${from} AND s.sold_at < ${to}
          ${branch}
        GROUP BY s.sold_at::date ORDER BY key`;
      return rows.map((r) => ({
        name: r.key.toISOString().slice(0, 10),
        qtyBase: Number(r.qty),
        receipts: Number(r.receipts),
        gross: r.gross,
      }));
    }

    const groupCol =
      groupBy === 'product' ? Prisma.sql`p.name` : Prisma.sql`c.name`;
    const rows = await this.prisma.$queryRaw<
      { name: string; gross: Prisma.Decimal; receipts: bigint; qty: bigint }[]
    >`
      SELECT ${groupCol} AS name, SUM(si.line_total) AS gross,
             COUNT(DISTINCT s.id) AS receipts, SUM(si.qty_base) AS qty
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
      JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'COMPLETED' AND s.sold_at >= ${from} AND s.sold_at < ${to}
        ${branch}
      GROUP BY ${groupCol} ORDER BY gross DESC`;
    return rows.map((r) => ({
      name: r.name,
      qtyBase: Number(r.qty),
      receipts: Number(r.receipts),
      gross: r.gross,
    }));
  }

  async stockValuation(branchId: string | null) {
    // v_stock_on_hand is one row per branch × product; consolidated mode sums
    // the branches back together rather than listing a product several times.
    const rows = branchId
      ? await this.prisma.$queryRaw<StockValuationRow[]>`
          SELECT product_id, name, base_unit, qty_base, value_at_cost, reorder_level
          FROM v_stock_on_hand
          WHERE branch_id = ${branchId}::uuid
          ORDER BY value_at_cost DESC`
      : await this.prisma.$queryRaw<StockValuationRow[]>`
          SELECT product_id, name, base_unit,
                 SUM(qty_base) AS qty_base,
                 SUM(value_at_cost)::numeric(14,2) AS value_at_cost,
                 MAX(reorder_level) AS reorder_level
          FROM v_stock_on_hand
          GROUP BY product_id, name, base_unit
          ORDER BY value_at_cost DESC`;
    const data = rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      baseUnit: r.base_unit,
      qtyBase: Number(r.qty_base),
      valueAtCost: r.value_at_cost,
      reorderLevel: r.reorder_level,
    }));
    const totalValue = data.reduce((s, r) => s + Number(r.valueAtCost), 0);
    return { rows: data, totalValue: totalValue.toFixed(2) };
  }

  async expiring(windowDays: number, branchId: string | null) {
    const rows = await this.prisma.$queryRaw<
      { branch_code: string; product_name: string; batch_number: string; expiry_date: Date; days_to_expiry: number; qty_on_hand: number; value_at_risk: Prisma.Decimal }[]
    >`
      SELECT branch_code, product_name, batch_number, expiry_date, days_to_expiry, qty_on_hand, value_at_risk
      FROM v_expiring_batches
      WHERE days_to_expiry <= ${windowDays}
        ${this.branchFilter(branchId, 'branch_id')}
      ORDER BY expiry_date`;
    const data = rows.map((r) => ({
      branchCode: r.branch_code,
      productName: r.product_name,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date.toISOString().slice(0, 10),
      daysToExpiry: r.days_to_expiry,
      qtyOnHand: r.qty_on_hand,
      valueAtRisk: r.value_at_risk,
    }));
    const valueAtRisk = data.reduce((s, r) => s + Number(r.valueAtRisk), 0);
    return { rows: data, valueAtRisk: valueAtRisk.toFixed(2) };
  }

  /** Approved negative adjustments over a range (v_shrinkage is all-time). */
  async shrinkage(from: Date, to: Date, branchId: string | null) {
    const rows = await this.prisma.$queryRaw<
      { reason: string; adjustments: bigint; qty_base: bigint; value: Prisma.Decimal }[]
    >`
      SELECT sa.reason::text, COUNT(*) AS adjustments, SUM(sa.qty_delta) AS qty_base,
             SUM(sa.qty_delta * b.unit_cost)::numeric(14,2) AS value
      FROM stock_adjustments sa JOIN batches b ON b.id = sa.batch_id
      WHERE sa.status = 'APPROVED' AND sa.qty_delta < 0
        AND sa.decided_at >= ${from} AND sa.decided_at < ${to}
        ${this.branchFilter(branchId, 'sa.branch_id')}
      GROUP BY sa.reason`;
    return {
      rows: rows.map((r) => ({
        reason: r.reason,
        adjustments: Number(r.adjustments),
        qtyBase: Number(r.qty_base),
        value: r.value,
      })),
    };
  }

  /** CSV export for any of the named reports (US-13 AC3). */
  async exportCsv(
    name: string,
    opts: { from: Date; to: Date; groupBy: SalesGroupBy; window: number; branchId: string | null },
  ): Promise<{ filename: string; csv: string }> {
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const toCsv = (headers: string[], rows: unknown[][]) =>
      [headers.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n') + '\n';

    switch (name) {
      case 'sales': {
        const rows = await this.salesReport(opts.from, opts.to, opts.groupBy, opts.branchId);
        return {
          filename: `sales-by-${opts.groupBy}.csv`,
          csv: toCsv(
            [opts.groupBy, 'qty_base', 'receipts', 'gross_ghs'],
            rows.map((r) => [r.name, r.qtyBase, r.receipts, r.gross]),
          ),
        };
      }
      case 'stock-valuation': {
        const { rows } = await this.stockValuation(opts.branchId);
        return {
          filename: 'stock-valuation.csv',
          csv: toCsv(
            ['product', 'base_unit', 'qty_base', 'reorder_level', 'value_at_cost_ghs'],
            rows.map((r) => [r.name, r.baseUnit, r.qtyBase, r.reorderLevel, r.valueAtCost]),
          ),
        };
      }
      case 'expiring': {
        const { rows } = await this.expiring(opts.window, opts.branchId);
        return {
          filename: `expiring-${opts.window}d.csv`,
          csv: toCsv(
            ['product', 'batch', 'expiry_date', 'days_to_expiry', 'qty_on_hand', 'value_at_risk_ghs'],
            rows.map((r) => [r.productName, r.batchNumber, r.expiryDate, r.daysToExpiry, r.qtyOnHand, r.valueAtRisk]),
          ),
        };
      }
      case 'shrinkage': {
        const { rows } = await this.shrinkage(opts.from, opts.to, opts.branchId);
        return {
          filename: 'shrinkage.csv',
          csv: toCsv(
            ['reason', 'adjustments', 'qty_base', 'value_ghs'],
            rows.map((r) => [r.reason, r.adjustments, r.qtyBase, r.value]),
          ),
        };
      }
      default:
        throw new DomainException('UNKNOWN_REPORT', `No report named "${name}"`, {
          known: ['sales', 'stock-valuation', 'expiring', 'shrinkage'],
        });
    }
  }

  async daily(date: string, branchId: string | null) {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const range = { gte: dayStart, lt: dayEnd };
    const branch = this.branchFilter(branchId, 's.branch_id');

    const [totals, byMethod, byCashier] = await Promise.all([
      // Prisma call, so the extension scopes it — but be explicit so a
      // consolidated (null-branch) read still means what it says.
      this.prisma.sale.aggregate({
        where: { status: 'COMPLETED', soldAt: range, ...(branchId ? { branchId } : {}) },
        _sum: { total: true, vatTotal: true, discountTotal: true },
        _count: true,
      }),
      this.prisma.$queryRaw<{ method: string; amount: Prisma.Decimal }[]>`
        SELECT p.method::text, COALESCE(SUM(p.amount), 0) AS amount
        FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= ${dayStart} AND s.sold_at < ${dayEnd}
          ${branch}
        GROUP BY p.method`,
      this.prisma.$queryRaw<
        { cashier_id: string; cashier_name: string; amount: Prisma.Decimal; receipts: bigint }[]
      >`
        SELECT s.cashier_id, u.full_name AS cashier_name,
               COALESCE(SUM(s.total), 0) AS amount, COUNT(*) AS receipts
        FROM sales s JOIN users u ON u.id = s.cashier_id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= ${dayStart} AND s.sold_at < ${dayEnd}
          ${branch}
        GROUP BY s.cashier_id, u.full_name
        ORDER BY amount DESC`,
    ]);

    return {
      date,
      gross: totals._sum.total ?? new Prisma.Decimal(0),
      receipts: totals._count,
      vat: totals._sum.vatTotal ?? new Prisma.Decimal(0),
      discounts: totals._sum.discountTotal ?? new Prisma.Decimal(0),
      byMethod: byMethod.map((r) => ({ method: r.method, amount: r.amount })),
      byCashier: byCashier.map((r) => ({
        cashierId: r.cashier_id,
        cashierName: r.cashier_name,
        amount: r.amount,
        receipts: Number(r.receipts),
      })),
    };
  }

  /** Owner's morning view (wireframes ★ Screen 4) in one call — 3G-friendly. */
  async dashboard(branchId: string | null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days14 = new Date(today.getTime() - 13 * 86_400_000);
    const week = new Date(today.getTime() - 6 * 86_400_000);
    const sBranch = this.branchFilter(branchId, 's.branch_id');

    const [daily, lowStock, expiring, expired, trend, topSellers] = await Promise.all([
      this.daily(new Date().toISOString().slice(0, 10), branchId),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM v_low_stock
        WHERE TRUE ${this.branchFilter(branchId, 'branch_id')}`,
      this.prisma.$queryRaw<{ count: bigint; value: Prisma.Decimal | null }[]>`
        SELECT COUNT(*) AS count, SUM(value_at_risk) AS value
        FROM v_expiring_batches WHERE days_to_expiry >= 0
          ${this.branchFilter(branchId, 'branch_id')}`,
      this.prisma.batch.count({
        where: {
          ...(branchId ? { branchId } : {}),
          qtyOnHand: { gt: 0 },
          OR: [{ status: 'EXPIRED' }, { expiryDate: { lte: new Date() }, status: 'ACTIVE' }],
        },
      }),
      this.prisma.$queryRaw<{ day: Date; gross: Prisma.Decimal; receipts: bigint }[]>`
        SELECT sold_at::date AS day, SUM(total) AS gross, COUNT(*) AS receipts
        FROM sales s WHERE status = 'COMPLETED' AND sold_at >= ${days14}
          ${sBranch}
        GROUP BY sold_at::date ORDER BY day`,
      this.prisma.$queryRaw<{ name: string; qty: bigint }[]>`
        SELECT p.name, SUM(si.qty_base) AS qty
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
        JOIN products p ON p.id = si.product_id
        WHERE s.sold_at >= ${week}
          ${sBranch}
        GROUP BY p.name ORDER BY qty DESC LIMIT 5`,
    ]);

    return {
      today: daily,
      actionNeeded: {
        lowStockCount: Number(lowStock[0]?.count ?? 0),
        expiringCount: Number(expiring[0]?.count ?? 0),
        expiringValue: expiring[0]?.value ?? new Prisma.Decimal(0),
        expiredCount: expired,
      },
      trend14d: trend.map((t) => ({
        day: t.day.toISOString().slice(0, 10),
        gross: t.gross,
        receipts: Number(t.receipts),
      })),
      topSellers: topSellers.map((t) => ({ name: t.name, qtyBase: Number(t.qty) })),
    };
  }
}
