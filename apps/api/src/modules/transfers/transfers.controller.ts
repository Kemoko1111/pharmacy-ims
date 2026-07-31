import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { TransfersService } from './transfers.service';
import { CreateTransferDto, ReceiveTransferDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @Roles('MANAGER', 'PHARMACIST', 'INVENTORY_OFFICER')
  list(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    return this.transfers.list(user, {
      page: Number(page ?? 1),
      pageSize: Math.min(Number(pageSize ?? 50), 200),
      status,
    });
  }

  /** Value dispatched but not yet received — still the sender's asset (ADR-010). */
  @Get('in-transit')
  @Roles('MANAGER')
  inTransit(@CurrentUser() user: RequestUser) {
    return this.transfers.inTransit(user);
  }

  @Get(':id')
  @Roles('MANAGER', 'PHARMACIST', 'INVENTORY_OFFICER')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.transfers.get(id, user);
  }

  @Post()
  @Roles('MANAGER', 'INVENTORY_OFFICER')
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: RequestUser) {
    return this.transfers.create(dto, user);
  }

  @Post(':id/dispatch')
  @Roles('MANAGER', 'INVENTORY_OFFICER')
  @HttpCode(200)
  dispatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.transfers.dispatch(id, user);
  }

  @Post(':id/receive')
  @Roles('MANAGER', 'INVENTORY_OFFICER')
  @HttpCode(200)
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveTransferDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.transfers.receive(id, dto, user);
  }

  @Post(':id/cancel')
  @Roles('MANAGER')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.transfers.cancel(id, user);
  }
}
