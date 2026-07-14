import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
/** Roles allowed on a route. ADMIN always passes (matrix in api-schema.md). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
