import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ReportingService } from './reporting.service';
import { Roles } from '../../common/roles.decorator';

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
}
