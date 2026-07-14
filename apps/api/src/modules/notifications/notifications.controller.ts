import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.decorator';
import { PageQuery, listEnvelope } from '../../common/pagination';

class NotificationsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  unseen?: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('MANAGER', 'PHARMACIST')
  async list(@Query() q: NotificationsQuery) {
    const where = q.unseen === 'true' ? { seenAt: null } : {};
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return listEnvelope(rows, page, pageSize, total);
  }

  @Post(':id/seen')
  @Roles('MANAGER', 'PHARMACIST')
  @HttpCode(204)
  async markSeen(@Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.notification.update({ where: { id }, data: { seenAt: new Date() } });
  }
}
