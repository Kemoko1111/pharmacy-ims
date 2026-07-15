import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from './sms.service';

/**
 * Scheduled sweeps (api-schema.md §Cross-cutting). Handlers are plain methods
 * so tests call them directly; CRON_DISABLED=true skips them (tests, one-off
 * scripts). SMS goes to the `alert_phone` setting when present.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  @Cron('0 2 * * *')
  async expirySweepCron() {
    if (process.env.CRON_DISABLED === 'true') return;
    await this.expirySweep();
  }

  @Cron('*/15 * * * *')
  async lowStockScanCron() {
    if (process.env.CRON_DISABLED === 'true') return;
    await this.lowStockScan();
  }

  /** Nightly: flag expired batches, warn on the ≤N-day window, SMS summary. */
  async expirySweep(): Promise<{ expired: number; warned: number }> {
    const newlyExpired = await this.prisma.batch.findMany({
      where: { status: 'ACTIVE', expiryDate: { lte: new Date() } },
      include: { product: { select: { name: true } } },
    });

    for (const batch of newlyExpired) {
      await this.prisma.batch.update({ where: { id: batch.id }, data: { status: 'EXPIRED' } });
      await this.prisma.notification.create({
        data: {
          id: uuid(),
          type: 'EXPIRED',
          payload: {
            batchId: batch.id,
            productId: batch.productId,
            productName: batch.product.name,
            batchNumber: batch.batchNumber,
            qtyOnHand: batch.qtyOnHand,
            valueAtCost: batch.unitCost.mul(batch.qtyOnHand).toString(),
          },
        },
      });
    }

    // Early warning (US-13): batches entering the expiry_warn_days window get
    // one open EXPIRY_90 notification each — same dedupe rule as low stock.
    const warnDays = Number(
      (await this.prisma.setting.findUnique({ where: { key: 'expiry_warn_days' } }))?.value ?? 90,
    );
    const expiringSoon = await this.prisma.batch.findMany({
      where: {
        status: 'ACTIVE',
        qtyOnHand: { gt: 0 },
        expiryDate: { gt: new Date(), lte: new Date(Date.now() + warnDays * 86_400_000) },
      },
      include: { product: { select: { name: true } } },
    });
    let warned = 0;
    for (const batch of expiringSoon) {
      const open = await this.prisma.notification.findFirst({
        where: { type: 'EXPIRY_90', seenAt: null, payload: { path: ['batchId'], equals: batch.id } },
      });
      if (open) continue;
      await this.prisma.notification.create({
        data: {
          id: uuid(),
          type: 'EXPIRY_90',
          payload: {
            batchId: batch.id,
            productId: batch.productId,
            productName: batch.product.name,
            batchNumber: batch.batchNumber,
            expiryDate: batch.expiryDate.toISOString().slice(0, 10),
            qtyOnHand: batch.qtyOnHand,
            valueAtRisk: batch.unitCost.mul(batch.qtyOnHand).toString(),
          },
        },
      });
      warned++;
    }

    if (newlyExpired.length > 0 || warned > 0) {
      this.logger.warn(`expiry sweep: ${newlyExpired.length} expired, ${warned} new ≤${warnDays}d warnings`);
      const parts = [];
      if (newlyExpired.length > 0) parts.push(`${newlyExpired.length} batch(es) EXPIRED — quarantine now`);
      if (warned > 0) parts.push(`${warned} batch(es) expire within ${warnDays} days`);
      await this.smsAlert(`PharmaTrack: ${parts.join('; ')}.`);
    }
    return { expired: newlyExpired.length, warned };
  }

  /** Every 15 min: low-stock scan; one open notification per product, no spam. */
  async lowStockScan(): Promise<{ notified: number }> {
    const low = await this.prisma.$queryRaw<
      { product_id: string; name: string; qty_base: bigint; reorder_level: number }[]
    >`SELECT product_id, name, qty_base, reorder_level FROM v_low_stock`;

    let notified = 0;
    for (const row of low) {
      const existing = await this.prisma.notification.findFirst({
        where: {
          type: 'LOW_STOCK',
          seenAt: null,
          payload: { path: ['productId'], equals: row.product_id },
        },
      });
      if (existing) continue;
      await this.prisma.notification.create({
        data: {
          id: uuid(),
          type: 'LOW_STOCK',
          payload: {
            productId: row.product_id,
            productName: row.name,
            qtyBase: Number(row.qty_base),
            reorderLevel: row.reorder_level,
          } as Prisma.InputJsonValue,
        },
      });
      notified++;
    }

    if (notified > 0) {
      await this.smsAlert(`PharmaTrack: ${notified} product(s) hit their reorder level.`);
    }
    return { notified };
  }

  private async smsAlert(message: string) {
    const phone = (await this.prisma.setting.findUnique({ where: { key: 'alert_phone' } }))?.value;
    if (typeof phone === 'string' && phone) {
      await this.sms.send(phone, message);
    }
  }
}
