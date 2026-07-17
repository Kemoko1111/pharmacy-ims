import { Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { PageQuery, listEnvelope } from '../../common/pagination';
import { CustomerDto, CustomerPatchDto } from './dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: PageQuery) {
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

  create(dto: CustomerDto) {
    return this.prisma.customer.create({
      data: {
        id: uuid(),
        fullName: dto.fullName,
        phone: dto.phone || null,
        notes: dto.notes ?? null,
      },
    });
  }

  update(id: string, dto: CustomerPatchDto) {
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  async history(id: string, q: PageQuery) {
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
