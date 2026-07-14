import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.decorator';
import { PageQuery, listEnvelope } from '../../common/pagination';

/**
 * US-15: customer records are health-adjacent (purchase history reveals
 * conditions), so access is Pharmacist/Manager only per the Act 843 note in
 * the requirements doc. `notes` is the clinically sensitive field.
 */
class CustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

class CustomerPatchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('PHARMACIST', 'MANAGER')
  async list(@Query() q: PageQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where = {
      deletedAt: null,
      ...(q.q
        ? {
            OR: [
              { fullName: { contains: q.q, mode: 'insensitive' as const } },
              { phone: { contains: q.q } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { fullName: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ]);
    return listEnvelope(rows, page, pageSize, total);
  }

  @Post()
  @Roles('PHARMACIST', 'MANAGER')
  create(@Body() dto: CustomerDto) {
    return this.prisma.customer.create({
      data: {
        id: uuid(),
        fullName: dto.fullName,
        phone: dto.phone || null,
        notes: dto.notes ?? null,
      },
    });
  }

  @Patch(':id')
  @Roles('PHARMACIST', 'MANAGER')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerPatchDto) {
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  @Get(':id/history')
  @Roles('PHARMACIST', 'MANAGER')
  async history(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    const customer = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!customer) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Customer not found' });

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where: { customerId: id, status: 'COMPLETED' },
        include: { items: { include: { product: { select: { name: true } } } } },
        orderBy: { soldAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.sale.count({ where: { customerId: id, status: 'COMPLETED' } }),
    ]);
    return listEnvelope(
      rows.map((s) => ({
        id: s.id,
        receiptNumber: s.receiptNumber,
        soldAt: s.soldAt,
        total: s.total,
        items: s.items
          .filter((i) => i.quantity > 0)
          .map((i) => `${i.quantity}× ${i.product.name}`)
          .join(', '),
      })),
      page,
      pageSize,
      total,
    );
  }
}
