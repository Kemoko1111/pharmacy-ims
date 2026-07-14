import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { PageQuery, listEnvelope } from '../../common/pagination';

class SupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

class SupplierPatchDto extends SupplierDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;
}

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('INVENTORY_OFFICER', 'MANAGER', 'PHARMACIST')
  async list(@Query() q: PageQuery) {
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

  @Post()
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  create(@Body() dto: SupplierDto, @CurrentUser() actor: RequestUser) {
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

  @Patch(':id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierPatchDto) {
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

  @Delete(':id')
  @Roles('MANAGER')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.supplier.update({ where: { id }, data: { deletedAt: new Date() } });
  }
}
