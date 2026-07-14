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

  /** Nightly: flag expired batches, notify, SMS summary. */
  async expirySweep(): Promise<{ expired: number }> {
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

    if (newlyExpired.length > 0) {
      this.logger.warn(`expiry sweep: ${newlyExpired.length} batches expired`);
      await this.smsAlert(
        `PharmaTrack: ${newlyExpired.length} batch(es) EXPIRED overnight. Open the dashboard to quarantine.`,
      );
    }
    return { expired: newlyExpired.length };
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
