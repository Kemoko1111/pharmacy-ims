import { BadRequestException, Body, Controller, Get, Patch } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

/**
 * Whitelisted keys with a shape check each — settings drive money math and
 * approval gates, so no free-form writes.
 */
const KNOWN_KEYS: Record<string, (v: unknown) => boolean> = {
  vat_rate: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  expiry_warn_days: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365,
  adjust_approval_threshold: (v) => typeof v === 'number' && v >= 0,
  alert_phone: (v) => typeof v === 'string' && (v === '' || /^\+?[\d\s-]{7,20}$/.test(v)),
  receipt_header: (v) =>
    typeof v === 'object' &&
    v !== null &&
    Object.entries(v as Record<string, unknown>).every(
      ([k, val]) => ['line1', 'line2', 'line3'].includes(k) && typeof val === 'string',
    ),
};

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('ADMIN', 'MANAGER')
  async get() {
    const rows = await this.prisma.setting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** PATCH { key: value, … } — each change audited (api-schema.md). */
  @Patch()
  @Roles('ADMIN')
  async patch(@Body() body: Record<string, unknown>, @CurrentUser() actor: RequestUser) {
    const entries = Object.entries(body ?? {});
    if (entries.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_PATCH', message: 'No settings in body' });
    }
    for (const [key, value] of entries) {
      const validator = KNOWN_KEYS[key];
      if (!validator) {
        throw new BadRequestException({
          code: 'UNKNOWN_SETTING',
          message: `Unknown setting "${key}"`,
          details: { known: Object.keys(KNOWN_KEYS) },
        });
      }
      if (!validator(value)) {
        throw new BadRequestException({
          code: 'BAD_SETTING_VALUE',
          message: `Invalid value for "${key}"`,
        });
      }
    }

    for (const [key, value] of entries) {
      const before = await this.prisma.setting.findUnique({ where: { key } });
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue, updatedBy: actor.id },
        update: { value: value as Prisma.InputJsonValue, updatedBy: actor.id },
      });
      await this.audit.log({
        userId: actor.id,
        action: 'settings.change',
        entity: 'setting',
        entityId: key,
        before: before?.value,
        after: value,
      });
    }
    return this.get();
  }
}
