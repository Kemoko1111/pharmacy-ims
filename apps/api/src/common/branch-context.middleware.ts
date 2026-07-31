import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runInBranchContext } from './branch-context';

/**
 * Opens the per-request branch context (ADR-010).
 *
 * Middleware runs before guards, so the branch is not known yet — the store is
 * seeded in bypass mode and JwtAuthGuard fills it in once it has verified the
 * token. Seeding as bypass rather than "branch null" matters: an unauthenticated
 * request must not read as consolidated-all-branches.
 */
@Injectable()
export class BranchContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction) {
    runInBranchContext(
      { userId: '', role: '', branchId: null, branchIds: [], bypass: true },
      () => next(),
    );
  }
}
