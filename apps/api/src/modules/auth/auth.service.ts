import { HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';
import { v7 as uuid } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return hash(password); // argon2id defaults (ADR-005)
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * Which branches an actor may work in, and which one to start in (ADR-010).
   * ADMIN reaches every active branch; everyone else is limited to their
   * user_branches rows. The active branch is the one flagged `is_default`,
   * falling back to the first assigned.
   */
  private async resolveBranches(user: { id: string; role: string }) {
    const memberships = await this.prisma.userBranch.findMany({
      where: { userId: user.id, branch: { isActive: true } },
      include: { branch: { select: { id: true, code: true, name: true } } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    if (user.role === 'ADMIN') {
      const all = await this.prisma.branch.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      });
      if (all.length === 0) {
        throw new UnauthorizedException({
          code: 'NO_BRANCH_CONFIGURED',
          message: 'No active branch exists — create one first',
        });
      }
      const preferred = memberships[0]?.branch ?? all[0];
      return { branches: all, activeBranch: preferred };
    }

    if (memberships.length === 0) {
      throw new UnauthorizedException({
        code: 'NO_BRANCH_ASSIGNED',
        message: 'Your account is not assigned to a branch. Ask an administrator.',
      });
    }

    return {
      branches: memberships.map((m) => m.branch),
      activeBranch: memberships[0].branch,
    };
  }

  /** Signs an access token bound to a specific branch. */
  private signAccessToken(
    user: { id: string; username: string; role: string },
    branchId: string | null,
    branchIds: string[],
  ) {
    return this.jwt.signAsync({
      sub: user.id,
      username: user.username,
      role: user.role,
      branch: branchId,
      branches: branchIds,
    });
  }

  private async issueTokens(
    user: { id: string; username: string; role: string; fullName: string },
    deviceLabel?: string,
  ) {
    const { branches, activeBranch } = await this.resolveBranches(user);
    const branchIds = branches.map((b) => b.id);
    const accessToken = await this.signAccessToken(user, activeBranch.id, branchIds);

    const refreshToken = randomBytes(48).toString('base64url');
    const ttlHours = Number(process.env.JWT_REFRESH_TTL_HOURS ?? 12);
    await this.prisma.refreshToken.create({
      data: {
        id: uuid(),
        userId: user.id,
        tokenHash: this.sha256(refreshToken),
        deviceLabel: deviceLabel ?? null,
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        activeBranch,
        branches,
      },
    };
  }

  /**
   * Re-issues the access token against a different branch (ADR-010). The token
   * is the only thing that carries branch, so switching must round-trip — the
   * client cannot simply assert a new branch in a header.
   *
   * `branchId: null` is consolidated all-branch mode: ADMIN reporting only,
   * and the Prisma extension refuses writes while it is active.
   */
  async switchBranch(userId: string, branchId: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.isActive) {
      throw new UnauthorizedException({ code: 'USER_INACTIVE', message: 'Account is disabled' });
    }

    const { branches } = await this.resolveBranches(user);
    const branchIds = branches.map((b) => b.id);

    if (branchId === null) {
      if (user.role !== 'ADMIN') {
        throw new UnauthorizedException({
          code: 'CONSOLIDATED_FORBIDDEN',
          message: 'Only an administrator can view all branches at once',
        });
      }
    } else if (!branchIds.includes(branchId)) {
      throw new UnauthorizedException({
        code: 'BRANCH_FORBIDDEN',
        message: 'You are not assigned to that branch',
      });
    }

    await this.audit.log({
      userId,
      action: 'auth.switch_branch',
      entity: 'user',
      entityId: userId,
      after: { branchId },
    });

    return {
      accessToken: await this.signAccessToken(user, branchId, branchIds),
      activeBranch: branchId ? branches.find((b) => b.id === branchId)! : null,
      branches,
    };
  }

  async login(username: string, password: string, deviceLabel: string | undefined, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });

    // Uniform failure message — no username enumeration
    const invalid = () =>
      new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Wrong username or password' });

    if (!user || !user.isActive) {
      // burn comparable time so missing users aren't detectable by latency
      await verify(
        '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        password,
      ).catch(() => false);
      throw invalid();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(
        {
          code: 'ACCOUNT_LOCKED',
          message: `Account locked. Try again after ${user.lockedUntil.toISOString()}`,
        },
        423,
      );
    }

    const ok = await verify(user.passwordHash, password).catch(() => false);
    if (!ok) {
      const failed = user.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
        },
      });
      if (lock) {
        await this.audit.log({
          userId: user.id,
          action: 'auth.lockout',
          entity: 'user',
          entityId: user.id,
          after: { minutes: LOCKOUT_MINUTES },
          ip,
        });
        throw new HttpException(
          { code: 'ACCOUNT_LOCKED', message: `Too many attempts. Locked for ${LOCKOUT_MINUTES} minutes` },
          423,
        );
      }
      throw invalid();
    }

    if (user.failedLogins > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    await this.audit.log({
      userId: user.id,
      action: 'auth.login',
      entity: 'user',
      entityId: user.id,
      ip,
    });

    return this.issueTokens(user, deviceLabel);
  }

  async refresh(refreshToken: string) {
    const tokenHash = this.sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new UnauthorizedException({ code: 'TOKEN_INVALID', message: 'Unknown refresh token' });
    }

    // Rotation reuse detection (ADR-005): a revoked token presented again ⇒
    // assume theft, revoke the whole family for this user.
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.log({
        userId: stored.userId,
        action: 'auth.refresh_reuse_detected',
        entity: 'user',
        entityId: stored.userId,
      });
      throw new UnauthorizedException({ code: 'TOKEN_REUSED', message: 'Refresh token reuse detected' });
    }

    if (stored.expiresAt < new Date() || !stored.user.isActive) {
      throw new UnauthorizedException({ code: 'TOKEN_EXPIRED', message: 'Refresh token expired' });
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user, stored.deviceLabel ?? undefined);
  }

  async logout(refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string, activeBranchId: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { branches } = await this.resolveBranches(user);
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      activeBranch: activeBranchId ? (branches.find((b) => b.id === activeBranchId) ?? null) : null,
      branches,
    };
  }
}
