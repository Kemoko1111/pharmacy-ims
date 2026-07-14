import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SalesService } from './sales.service';
import { SaleCreateDto, SyncSalesDto, VoidSaleDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { PageQuery } from '../../common/pagination';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

class SalesQuery extends PageQuery {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  cashierId?: string;
}

class ReceiptQuery {
  @IsOptional()
  @IsString()
  reprint?: string;
}

@Controller()
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** 201 created · 409 duplicate clientSaleId returns the existing sale */
  @Post('sales')
  @Roles('CASHIER', 'PHARMACIST', 'MANAGER')
  async create(@Body() dto: SaleCreateDto, @CurrentUser() actor: RequestUser, @Res() res: Response) {
    const { sale, duplicate } = await this.sales.createSale(dto, actor, false);
    res.status(duplicate ? 409 : 201).json(sale);
  }

  /** Idempotent offline queue drain (ADR-006). */
  @Post('sync/sales')
  @Roles('CASHIER', 'PHARMACIST', 'MANAGER')
  @HttpCode(200)
  sync(@Body() dto: SyncSalesDto, @CurrentUser() actor: RequestUser) {
    return this.sales.syncSales(dto.sales, actor);
  }

  @Get('sales')
  @Roles('CASHIER', 'PHARMACIST', 'MANAGER')
  list(@Query() q: SalesQuery, @CurrentUser() actor: RequestUser) {
    return this.sales.listSales(actor, {
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 25,
      from: q.from,
      to: q.to,
      cashierId: q.cashierId,
      q: q.q,
    });
  }

  @Get('sales/:id')
  @Roles('CASHIER', 'PHARMACIST', 'MANAGER')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: RequestUser) {
    return this.sales.getSale(id, actor);
  }

  @Get('sales/:id/receipt')
  @Roles('CASHIER', 'PHARMACIST', 'MANAGER')
  receipt(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: RequestUser,
    @Query() q: ReceiptQuery,
  ) {
    return this.sales.receipt(id, actor, q.reprint === 'true');
  }

  @Post('sales/:id/void')
  @Roles('MANAGER')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidSaleDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.sales.voidSale(id, dto.reason, actor);
  }
}
