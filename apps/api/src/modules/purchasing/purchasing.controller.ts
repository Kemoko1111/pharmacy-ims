import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PurchasingService } from './purchasing.service';
import { CreatePoDto, CreateReceiptDto, FromSuggestionsDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { PageQuery } from '../../common/pagination';
import { ForbiddenException } from '@nestjs/common';
import { IsOptional, IsString, IsUUID } from 'class-validator';

class PosQuery extends PageQuery {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;
}

class ReceiptsQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  poId?: string;
}

@Controller()
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get('purchase-orders')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  listPos(@Query() q: PosQuery) {
    return this.purchasing.listPos({
      page: q.page ?? 1,
      pageSize: q.pageSize ?? 25,
      status: q.status,
      supplierId: q.supplierId,
    });
  }

  @Get('purchase-orders/:id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  getPo(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.getPo(id);
  }

  @Post('purchase-orders')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  createPo(@Body() dto: CreatePoDto, @CurrentUser() actor: RequestUser) {
    return this.purchasing.createPo(dto, actor);
  }

  @Post('purchase-orders/from-suggestions')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  fromSuggestions(@Body() dto: FromSuggestionsDto, @CurrentUser() actor: RequestUser) {
    return this.purchasing.fromSuggestions(dto, actor);
  }

  @Post('purchase-orders/:id/send')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: RequestUser) {
    return this.purchasing.sendPo(id, actor);
  }

  @Post('goods-receipts')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  receive(@Body() dto: CreateReceiptDto, @CurrentUser() actor: RequestUser) {
    // The over-receipt override is a Manager sign-off (US-09 AC2)
    if (dto.allowOverReceipt && !['MANAGER', 'ADMIN'].includes(actor.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Over-receipt approval requires a Manager',
      });
    }
    return this.purchasing.receive(dto, actor);
  }

  @Get('goods-receipts')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  listReceipts(@Query() q: ReceiptsQuery) {
    return this.purchasing.listReceipts({ page: q.page ?? 1, pageSize: q.pageSize ?? 25, poId: q.poId });
  }

  @Get('goods-receipts/:id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  getReceipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchasing.getReceipt(id);
  }
}
