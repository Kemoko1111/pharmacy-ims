/**
 * Per-request branch context (ADR-010).
 *
 * The branch a request acts in is carried in the JWT and stashed here for the
 * lifetime of the request, so the Prisma extension in
 * `prisma/branch-scope.extension.ts` can scope queries without every service
 * remembering to pass a branchId. Services that need it explicitly (raw SQL)
 * read it back via `currentBranchContext()`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface BranchContext {
  userId: string;
  role: string;
  /**
   * The branch this request acts in. `null` means a consolidated read across
   * every branch — reporting only. Writes with a null branch are refused.
   */
  branchId: string | null;
  /** Branches the actor may act in. Empty for ADMIN, who reaches all of them. */
  branchIds: string[];
  /**
   * Escape hatch for operations that legitimately span branches (stock
   * transfers, the seed, cron jobs). Set only via `runUnscoped`.
   */
  bypass?: boolean;
}

const store = new AsyncLocalStorage<BranchContext>();

export function runInBranchContext<T>(ctx: BranchContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentBranchContext(): BranchContext | undefined {
  return store.getStore();
}

/**
 * Fills in the context seeded by BranchContextMiddleware once the JWT guard has
 * identified the actor. Mutates in place: AsyncLocalStorage holds a reference,
 * so everything downstream in the request sees it.
 */
export function setBranchContext(patch: Partial<BranchContext>): void {
  const ctx = store.getStore();
  if (ctx) Object.assign(ctx, patch);
}

/**
 * Runs `fn` with branch scoping disabled. Use only for genuinely cross-branch
 * work — never to paper over a missing branch filter.
 *
 * IMPORTANT: Prisma promises are lazy, so the extension reads this context when
 * the query is awaited, not when it is built. `fn` must therefore be `async` and
 * await its queries internally:
 *
 *     await runUnscoped(async () => { await tx.foo.create(...); });   // correct
 *     await runUnscoped(() => tx.foo.create(...));                    // WRONG
 *
 * The second form returns an unexecuted promise and the scope has closed by the
 * time it runs, so the bypass silently does nothing.
 */
export function runUnscoped<T>(fn: () => T): T {
  const current = store.getStore();
  return store.run({ ...(current ?? { userId: '', role: 'SYSTEM', branchId: null, branchIds: [] }), bypass: true }, fn);
}

/**
 * The branch a write must be stamped with. Throws when the request is in
 * consolidated (all-branch) mode, which must never produce writes.
 */
export function requireBranchId(): string {
  const ctx = currentBranchContext();
  if (!ctx?.branchId) {
    throw new Error('BRANCH_CONTEXT_MISSING: a write was attempted without an active branch');
  }
  return ctx.branchId;
}
