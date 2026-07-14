import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { PageQuery, listEnvelope } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

class AuditQuery extends PageQuery {
  entity?: string;
  entityId?: string;
  userId?: string;
  from?: string;
  to?: string;
}

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('ADMIN', 'MANAGER')
  async list(@Query() q: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return listEnvelope(
      rows.map((r) => ({ ...r, id: r.id.toString() })),
      page,
      pageSize,
      total,
    );
  }
}
