import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { RequestUser } from './jwt-auth.guard';

/**
 * Server-side RBAC (ADR-005): single enforcement point; the UI only hides
 * what this guard would refuse. No @Roles() ⇒ any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const user = ctx.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (!user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'No user context' });
    if (user.role === 'ADMIN') return true;
    if (roles.includes(user.role as UserRole)) return true;
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: `Requires role: ${roles.join(' or ')}`,
    });
  }
}
