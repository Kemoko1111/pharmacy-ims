import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReportingService, SalesGroupBy } from './reporting.service';
import { Roles } from '../../common/roles.decorator';
import { DomainException } from '../../common/domain.exception';

function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
    throw new BadRequestException({ code: 'BAD_DATE', message: 'from/to must be YYYY-MM-DD' });
  }
  // default: last 30 days, end-exclusive tomorrow
  const end = to ? new Date(`${to}T00:00:00`) : new Date();
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 30 * 86_400_000);
  return { from: start, to: end };
}

function parseGroupBy(groupBy?: string): SalesGroupBy {
  const g = groupBy ?? 'product';
  if (!['product', 'category', 'day'].includes(g)) {
    throw new BadRequestException({ code: 'BAD_GROUP', message: 'groupBy must be product|category|day' });
  }
  return g as SalesGroupBy;
}

@Controller('reports')
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get('daily')
  @Roles('MANAGER', 'PHARMACIST', 'CASHIER')
  daily(@Query('date') date?: string) {
    const d = date ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new BadRequestException({ code: 'BAD_DATE', message: 'date must be YYYY-MM-DD' });
    }
    return this.reporting.daily(d);
  }

  @Get('dashboard')
  @Roles('MANAGER', 'PHARMACIST')
  dashboard() {
    return this.reporting.dashboard();
  }

  @Get('sales')
  @Roles('MANAGER')
  async sales(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    const range = parseRange(from, to);
    return { rows: await this.reporting.salesReport(range.from, range.to, parseGroupBy(groupBy)) };
  }

  @Get('stock-valuation')
  @Roles('MANAGER')
  stockValuation() {
    return this.reporting.stockValuation();
  }

  @Get('expiring')
  @Roles('MANAGER', 'PHARMACIST')
  expiring(@Query('window') window?: string) {
    const w = Number(window ?? 90);
    if (![30, 60, 90].includes(w)) {
      throw new BadRequestException({ code: 'BAD_WINDOW', message: 'window must be 30|60|90' });
    }
    return this.reporting.expiring(w);
  }

  @Get('shrinkage')
  @Roles('MANAGER')
  shrinkage(@Query('from') from?: string, @Query('to') to?: string) {
    const range = parseRange(from, to);
    return this.reporting.shrinkage(range.from, range.to);
  }

  /** US-13 AC3 — file stream. CSV now; PDF is a Phase 2 spike. */
  @Get(':name/export')
  @Roles('MANAGER')
  async export(
    @Param('name') name: string,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
    @Query('window') window?: string,
  ) {
    if ((format ?? 'csv') !== 'csv') {
      throw new DomainException('FORMAT_UNSUPPORTED', 'Only CSV export ships in MVP; PDF is Phase 2');
    }
    const range = parseRange(from, to);
    const { filename, csv } = await this.reporting.exportCsv(name, {
      from: range.from,
      to: range.to,
      groupBy: parseGroupBy(groupBy),
      window: Number(window ?? 90),
    });
    res
      .status(200)
      .setHeader('content-type', 'text/csv; charset=utf-8')
      .setHeader('content-disposition', `attachment; filename="${filename}"`)
      .send(csv);
  }
}
