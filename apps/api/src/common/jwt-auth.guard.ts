import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';
import { setBranchContext } from './branch-context';

export interface RequestUser {
  id: string;
  username: string;
  role: string;
  /**
   * Branch the request acts in, carried in the token (ADR-010). `null` is
   * consolidated all-branch mode — ADMIN reporting only, never a write.
   */
  branchId: string | null;
  /** Branches the actor may act in. Empty for ADMIN, who reaches all. */
  branchIds: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Missing bearer token' });
    }
    try {
      const payload = await this.jwt.verifyAsync(header.slice(7), {
        secret: process.env.JWT_ACCESS_SECRET,
      });

      const branchId: string | null = payload.branch ?? null;
      const branchIds: string[] = payload.branches ?? [];

      // Only ADMIN may hold a branchless (consolidated) token; for anyone else
      // an absent branch means a stale token from before multi-branch.
      if (!branchId && payload.role !== 'ADMIN') {
        throw new UnauthorizedException({
          code: 'BRANCH_REQUIRED',
          message: 'Token carries no branch — sign in again',
        });
      }

      req.user = {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
        branchId,
        branchIds,
      };

      // Hand the branch to the Prisma extension for the rest of the request.
      setBranchContext({
        userId: payload.sub,
        role: payload.role,
        branchId,
        branchIds,
        bypass: false,
      });

      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException({
        code: 'TOKEN_INVALID',
        message: 'Access token invalid or expired',
      });
    }
  }
}
