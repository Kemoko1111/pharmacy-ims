/**
 * Branch isolation as a Prisma client extension (ADR-010).
 *
 * Multi-branch's real risk is not the migration — it is the sixty-odd query
 * sites where someone forgets `where: { branchId }` and one branch quietly
 * reads or writes another's stock. This turns that into one place.
 *
 * It cannot see raw SQL. `$queryRaw` callers must add the predicate by hand;
 * `currentBranchContext()` gives them the id, and the isolation spec covers
 * the ones that exist today.
 */
import { Prisma } from '@prisma/client';
import { currentBranchContext } from '../common/branch-context';

/** branch_id NOT NULL — every row belongs to exactly one branch. */
const STRICT_MODELS = new Set<string>([
  'Batch',
  'StockMovement',
  'StockAdjustment',
  'Sale',
  'PurchaseOrder',
  'GoodsReceipt',
  'BranchProductSetting',
]);

/** branch_id nullable — a null row is system-wide and visible everywhere. */
const SOFT_MODELS = new Set<string>(['Notification', 'AuditLog']);

const MANY_READS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const MANY_WRITES = new Set(['updateMany', 'deleteMany']);
/** `where` must keep a unique field at the top level, so these get a spread. */
const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

class BranchScopeError extends Error {}

/** Wrapping in AND never clobbers a caller's own `where` or `OR`. */
function and(where: unknown, filter: object) {
  return where ? { AND: [where, filter] } : filter;
}

/**
 * A caller may set branchId itself — a transfer writes the destination branch.
 * Allowed when the actor can reach that branch; otherwise it is exactly the
 * cross-branch write this extension exists to stop.
 */
function assertMayWriteTo(branchId: string, ctx: NonNullable<ReturnType<typeof currentBranchContext>>) {
  if (ctx.role === 'ADMIN') return;
  if (ctx.branchIds.includes(branchId)) return;
  throw new BranchScopeError(
    `BRANCH_FORBIDDEN: not a member of branch ${branchId}`,
  );
}

export const branchScopeExtension = Prisma.defineExtension({
  name: 'branch-scope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const ctx = currentBranchContext();
        const strict = !!model && STRICT_MODELS.has(model);
        const soft = !!model && SOFT_MODELS.has(model);

        // No context (startup, seed, scripts) or an explicit bypass: untouched.
        if (!ctx || ctx.bypass || (!strict && !soft)) return query(args);

        const a = (args ?? {}) as Record<string, unknown>;

        if (CREATES.has(operation)) {
          if (soft) {
            // Logs and notifications: stamp the branch when the caller omitted
            // it, but a deliberate null (system-wide) is left alone.
            const stamp = (row: Record<string, unknown>) =>
              'branchId' in row ? row : { ...row, branchId: ctx.branchId };
            if (Array.isArray(a.data)) a.data = (a.data as Record<string, unknown>[]).map(stamp);
            else if (a.data) a.data = stamp(a.data as Record<string, unknown>);
            return query(a);
          }

          if (!ctx.branchId && ctx.role !== 'ADMIN') {
            throw new BranchScopeError(
              `BRANCH_CONTEXT_MISSING: cannot create ${model} without an active branch`,
            );
          }
          const stamp = (row: Record<string, unknown>) => {
            if (row.branchId) {
              assertMayWriteTo(row.branchId as string, ctx);
              return row;
            }
            if (!ctx.branchId) {
              throw new BranchScopeError(
                `BRANCH_CONTEXT_MISSING: cannot create ${model} in consolidated mode`,
              );
            }
            return { ...row, branchId: ctx.branchId };
          };
          if (Array.isArray(a.data)) a.data = (a.data as Record<string, unknown>[]).map(stamp);
          else if (a.data) a.data = stamp(a.data as Record<string, unknown>);
          return query(a);
        }

        // Consolidated mode (ADMIN, branchId null): reads span every branch,
        // writes are refused outright.
        if (!ctx.branchId) {
          if (MANY_WRITES.has(operation) || UNIQUE_OPS.has(operation) || operation === 'upsert') {
            if (operation !== 'findUnique' && operation !== 'findUniqueOrThrow') {
              throw new BranchScopeError(
                `BRANCH_CONTEXT_MISSING: ${operation} on ${model} needs an active branch`,
              );
            }
          }
          return query(a);
        }

        const filter = strict
          ? { branchId: ctx.branchId }
          : { OR: [{ branchId: ctx.branchId }, { branchId: null }] };

        if (MANY_READS.has(operation) || MANY_WRITES.has(operation)) {
          a.where = and(a.where, filter);
          return query(a);
        }

        if (UNIQUE_OPS.has(operation)) {
          // Spread, not AND: `where` must keep its unique field at the top
          // level for Prisma to accept it.
          if (strict) {
            a.where = { ...(a.where as object), branchId: ctx.branchId };
          }
          return query(a);
        }

        if (operation === 'upsert') {
          if (strict) {
            a.where = { ...(a.where as object), branchId: ctx.branchId };
            if (a.create) {
              a.create = { ...(a.create as Record<string, unknown>), branchId: ctx.branchId };
            }
          }
          return query(a);
        }

        return query(a);
      },
    },
  },
});
