import { BadRequestException, Injectable } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateBranchDto, UpdateBranchDto } from './dto';

/**
 * Branch administration (ADR-010).
 *
 * `branches` is a shared table, not a branch-scoped one, so it sits outside the
 * branch-scope extension: everyone can see the list of shops (the transfer
 * destination picker and the user-assignment UI both need it), but only ADMIN
 * may change it.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(includeInactive = false) {
    return this.prisma.branch.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        address: true,
        phone: true,
        isActive: true,
      },
      orderBy: { code: 'asc' },
    });
  }

  async create(dto: CreateBranchDto, actorId: string) {
    const code = dto.code.toUpperCase();
    const clash = await this.prisma.branch.findUnique({ where: { code } });
    if (clash) {
      throw new BadRequestException({
        code: 'BRANCH_CODE_TAKEN',
        message: `Branch code "${code}" is already in use`,
      });
    }

    const branch = await this.prisma.branch.create({
      data: {
        id: uuid(),
        code,
        name: dto.name,
        address: dto.address ?? null,
        phone: dto.phone ?? null,
        receiptHeader: dto.receiptHeader ?? undefined,
      },
    });
    await this.audit.log({
      userId: actorId,
      action: 'branch.create',
      entity: 'branch',
      entityId: branch.id,
      after: { code: branch.code, name: branch.name },
    });
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto, actorId: string) {
    const before = await this.prisma.branch.findUniqueOrThrow({ where: { id } });

    // The code is baked into every receipt, PO and GRN already issued, so
    // renaming it would orphan those references.
    if (dto.code && dto.code.toUpperCase() !== before.code) {
      throw new BadRequestException({
        code: 'BRANCH_CODE_IMMUTABLE',
        message: 'Branch code cannot change — it is embedded in issued document numbers',
      });
    }

    const branch = await this.prisma.branch.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.receiptHeader !== undefined ? { receiptHeader: dto.receiptHeader } : {}),
      },
    });
    await this.audit.log({
      userId: actorId,
      action: 'branch.update',
      entity: 'branch',
      entityId: id,
      before,
      after: branch,
    });
    return branch;
  }
}
