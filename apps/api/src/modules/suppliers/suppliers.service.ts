import { Injectable } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { PageQuery, listEnvelope } from '../../common/pagination';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { SupplierDto, SupplierPatchDto } from './dto';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: PageQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const where = {
      deletedAt: null,
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' as const } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return listEnvelope(rows, page, pageSize, total);
  }

  create(dto: SupplierDto, actor: RequestUser) {
    return this.prisma.supplier.create({
      data: {
        id: uuid(),
        name: dto.name,
        contactName: dto.contactName ?? null,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        address: dto.address ?? null,
        createdBy: actor.id,
      },
    });
  }

  update(id: string, dto: SupplierPatchDto) {
    return this.prisma.supplier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.contactName !== undefined ? { contactName: dto.contactName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
      },
    });
  }

  async remove(id: string) {
    await this.prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
