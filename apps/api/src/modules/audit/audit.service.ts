import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  userId?: string | null;
  action: string; // 'sale.void', 'product.price_change', 'auth.lockout', …
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Attribution trail (BR-06). Called explicitly at domain events so the
 * before/after diff is meaningful, not a generic request dump.
 * Never throws — an audit failure must not break the business action.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    try {
      await (tx ?? this.prisma).auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          before: entry.before === undefined ? Prisma.DbNull : (entry.before as Prisma.InputJsonValue),
          after: entry.after === undefined ? Prisma.DbNull : (entry.after as Prisma.InputJsonValue),
          ipAddress: entry.ip ?? null,
        },
      });
    } catch (err) {
      this.logger.error({ err, entry }, 'audit write failed');
    }
  }
}
