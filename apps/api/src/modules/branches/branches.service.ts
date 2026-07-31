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

  async list(includeInactive = false) {
    const branches = await this.prisma.branch.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: {
        id: true,
        code: true,
        name: true,
        address: true,
        phone: true,
        receiptHeader: true,
        isActive: true,
      },
      orderBy: { code: 'asc' },
    });

    // How many documents already carry each branch's code prefix. Returned so
    // the UI can disable the code field with a reason instead of letting the
    // admin type a new code and only then be refused. One grouped query, and
    // raw because the branch-scope extension would filter these to the caller's
    // own branch (see `update`).
    const counts = await this.prisma.$queryRaw<{ branch_id: string; documents: bigint }[]>`
      SELECT branch_id, SUM(n) AS documents FROM (
        SELECT branch_id, COUNT(*) AS n FROM sales           GROUP BY branch_id
        UNION ALL
        SELECT branch_id, COUNT(*) AS n FROM purchase_orders GROUP BY branch_id
        UNION ALL
        SELECT branch_id, COUNT(*) AS n FROM goods_receipts  GROUP BY branch_id
        UNION ALL
        SELECT from_branch_id AS branch_id, COUNT(*) AS n FROM stock_transfers GROUP BY from_branch_id
        UNION ALL
        SELECT to_branch_id   AS branch_id, COUNT(*) AS n FROM stock_transfers GROUP BY to_branch_id
      ) t GROUP BY branch_id`;

    const byId = new Map(counts.map((c) => [c.branch_id, Number(c.documents)]));
    return branches.map((b) => ({
      ...b,
      documentCount: byId.get(b.id) ?? 0,
      /** The code is baked into issued document numbers once any exist. */
      codeLocked: (byId.get(b.id) ?? 0) > 0,
    }));
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

    // The code is baked into every receipt, PO, GRN and transfer number already
    // issued, so changing it once documents exist would orphan those references.
    // Before any are issued it is just a label, and a placeholder branch created
    // at install time has to be renameable once the real shop is known.
    //
    // Counted in raw SQL deliberately: the branch-scope extension would AND its
    // own branch filter onto these, so an admin scoped to branch A checking
    // branch B would always count zero and wrongly be allowed through.
    if (dto.code && dto.code.toUpperCase() !== before.code) {
      const [{ documents }] = await this.prisma.$queryRaw<{ documents: bigint }[]>`
        SELECT (
          (SELECT COUNT(*) FROM sales            WHERE branch_id = ${id}::uuid) +
          (SELECT COUNT(*) FROM purchase_orders  WHERE branch_id = ${id}::uuid) +
          (SELECT COUNT(*) FROM goods_receipts   WHERE branch_id = ${id}::uuid) +
          (SELECT COUNT(*) FROM stock_transfers  WHERE from_branch_id = ${id}::uuid
                                                    OR to_branch_id  = ${id}::uuid)
        ) AS documents`;

      if (Number(documents) > 0) {
        throw new BadRequestException({
          code: 'BRANCH_CODE_IMMUTABLE',
          message:
            `Branch code cannot change — ${documents} document(s) already carry the "${before.code}" prefix`,
          details: { documents: Number(documents) },
        });
      }

      const code = dto.code.toUpperCase();
      const clash = await this.prisma.branch.findFirst({ where: { code, NOT: { id } } });
      if (clash) {
        throw new BadRequestException({
          code: 'BRANCH_CODE_TAKEN',
          message: `Branch code "${code}" is already in use`,
        });
      }
    }

    const branch = await this.prisma.branch.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
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
