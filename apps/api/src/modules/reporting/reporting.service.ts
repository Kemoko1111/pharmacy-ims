import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(date: string) {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const range = { gte: dayStart, lt: dayEnd };

    const [totals, byMethod, byCashier] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { status: 'COMPLETED', soldAt: range },
        _sum: { total: true, vatTotal: true, discountTotal: true },
        _count: true,
      }),
      this.prisma.$queryRaw<{ method: string; amount: Prisma.Decimal }[]>`
        SELECT p.method::text, COALESCE(SUM(p.amount), 0) AS amount
        FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= ${dayStart} AND s.sold_at < ${dayEnd}
        GROUP BY p.method`,
      this.prisma.$queryRaw<
        { cashier_id: string; cashier_name: string; amount: Prisma.Decimal; receipts: bigint }[]
      >`
        SELECT s.cashier_id, u.full_name AS cashier_name,
               COALESCE(SUM(s.total), 0) AS amount, COUNT(*) AS receipts
        FROM sales s JOIN users u ON u.id = s.cashier_id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= ${dayStart} AND s.sold_at < ${dayEnd}
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
  async dashboard() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days14 = new Date(today.getTime() - 13 * 86_400_000);
    const week = new Date(today.getTime() - 6 * 86_400_000);

    const [daily, lowStock, expiring, expired, trend, topSellers] = await Promise.all([
      this.daily(new Date().toISOString().slice(0, 10)),
      this.prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM v_low_stock`,
      this.prisma.$queryRaw<{ count: bigint; value: Prisma.Decimal | null }[]>`
        SELECT COUNT(*) AS count, SUM(value_at_risk) AS value
        FROM v_expiring_batches WHERE days_to_expiry >= 0`,
      this.prisma.batch.count({
        where: {
          qtyOnHand: { gt: 0 },
          OR: [{ status: 'EXPIRED' }, { expiryDate: { lte: new Date() }, status: 'ACTIVE' }],
        },
      }),
      this.prisma.$queryRaw<{ day: Date; gross: Prisma.Decimal; receipts: bigint }[]>`
        SELECT sold_at::date AS day, SUM(total) AS gross, COUNT(*) AS receipts
        FROM sales WHERE status = 'COMPLETED' AND sold_at >= ${days14}
        GROUP BY sold_at::date ORDER BY day`,
      this.prisma.$queryRaw<{ name: string; qty: bigint }[]>`
        SELECT p.name, SUM(si.qty_base) AS qty
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.status = 'COMPLETED'
        JOIN products p ON p.id = si.product_id
        WHERE s.sold_at >= ${week}
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
