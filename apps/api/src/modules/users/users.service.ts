import { Injectable } from '@nestjs/common';
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
        select: publicUser,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);
    return listEnvelope(rows, page, pageSize, total);
  }

  async create(dto: CreateUserDto, actorId: string) {
    const user = await this.prisma.user.create({
      data: {
        id: uuid(),
        username: dto.username.toLowerCase(),
        fullName: dto.fullName,
        phone: dto.phone ?? null,
        role: dto.role,
        passwordHash: await AuthService.hashPassword(dto.password),
        createdBy: actorId,
      },
      select: publicUser,
    });
    await this.audit.log({
      userId: actorId,
      action: 'user.create',
      entity: 'user',
      entityId: user.id,
      after: { username: user.username, role: user.role },
    });
    return user;
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
    await this.audit.log({
      userId: actorId,
      action: 'user.update',
      entity: 'user',
      entityId: id,
      before,
      after: user,
    });
    return user;
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
