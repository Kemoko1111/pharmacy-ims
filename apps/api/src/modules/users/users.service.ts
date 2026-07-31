import { BadRequestException, Injectable } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CreateUserDto, UpdateUserDto } from './dto';
import { listEnvelope } from '../../common/pagination';

const publicUser = {
  id: true,
  username: true,
  fullName: true,
  phone: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(page: number, pageSize: number) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        select: {
          ...publicUser,
          branches: { include: { branch: { select: { id: true, code: true, name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);
    return listEnvelope(rows.map((r) => this.serialize(r)), page, pageSize, total);
  }

  async create(dto: CreateUserDto, actorId: string) {
    await this.assertBranchesExist(dto.branchIds);
    const defaultBranchId = this.resolveDefault(dto.branchIds, dto.defaultBranchId);

    const userId = uuid();
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          id: userId,
          username: dto.username.toLowerCase(),
          fullName: dto.fullName,
          phone: dto.phone ?? null,
          role: dto.role,
          passwordHash: await AuthService.hashPassword(dto.password),
          createdBy: actorId,
        },
        select: publicUser,
      });
      // Without a branch the account cannot sign in (ADR-010), so this is part
      // of creating the user, not a follow-up step someone might forget.
      await tx.userBranch.createMany({
        data: dto.branchIds.map((branchId) => ({
          userId,
          branchId,
          isDefault: branchId === defaultBranchId,
        })),
      });
      return created;
    });

    await this.audit.log({
      userId: actorId,
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      after: { username: user.username, role: user.role, branchIds: dto.branchIds },
    });
    return this.get(user.id);
  }

  async get(id: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: { ...publicUser, branches: { include: { branch: { select: { id: true, code: true, name: true } } } } },
    });
    return this.serialize(user);
  }

  private async assertBranchesExist(branchIds: string[]) {
    const found = await this.prisma.branch.count({
      where: { id: { in: branchIds }, isActive: true },
    });
    if (found !== new Set(branchIds).size) {
      throw new BadRequestException({
        code: 'BRANCH_UNKNOWN',
        message: 'One or more branches do not exist or are inactive',
      });
    }
  }

  private resolveDefault(branchIds: string[], requested?: string) {
    if (requested && !branchIds.includes(requested)) {
      throw new BadRequestException({
        code: 'DEFAULT_BRANCH_NOT_ASSIGNED',
        message: 'The default branch must be one of the assigned branches',
      });
    }
    return requested ?? branchIds[0];
  }

  private serialize(user: {
    branches: { branch: { id: string; code: string; name: string }; isDefault: boolean }[];
  } & Record<string, unknown>) {
    const { branches, ...rest } = user;
    return {
      ...rest,
      branches: branches.map((b) => b.branch),
      defaultBranchId: branches.find((b) => b.isDefault)?.branch.id ?? null,
    };
  }

  async update(id: string, dto: UpdateUserDto, actorId: string) {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: publicUser });
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: publicUser,
    });

    // Wholesale replace: the UI sends the full set, so a removed branch is a
    // deliberate revocation rather than an omission.
    if (dto.branchIds) {
      await this.assertBranchesExist(dto.branchIds);
      const defaultBranchId = this.resolveDefault(dto.branchIds, dto.defaultBranchId);
      await this.prisma.$transaction(async (tx) => {
        await tx.userBranch.deleteMany({ where: { userId: id } });
        await tx.userBranch.createMany({
          data: dto.branchIds!.map((branchId) => ({
            userId: id,
            branchId,
            isDefault: branchId === defaultBranchId,
          })),
        });
      });
      // Their token still names the old branch — force a fresh sign-in.
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await this.audit.log({
      userId: actorId,
      action: 'user.update',
      entity: 'user',
      entityId: id,
      before,
      after: { ...user, ...(dto.branchIds ? { branchIds: dto.branchIds } : {}) },
    });
    return this.get(id);
  }

  async resetPassword(id: string, newPassword: string, actorId: string) {
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await AuthService.hashPassword(newPassword), failedLogins: 0, lockedUntil: null },
    });
    // sign out everywhere
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      userId: actorId,
      action: 'user.reset_password',
      entity: 'user',
      entityId: id,
    });
  }
}
