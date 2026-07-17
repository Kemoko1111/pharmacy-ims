import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { PageQuery } from '../../common/pagination';
import { SuppliersService } from './suppliers.service';
import { SupplierDto, SupplierPatchDto } from './dto';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @Roles('INVENTORY_OFFICER', 'MANAGER', 'PHARMACIST')
  list(@Query() q: PageQuery) {
    return this.suppliers.list(q);
  }

  @Post()
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  create(@Body() dto: SupplierDto, @CurrentUser() actor: RequestUser) {
    return this.suppliers.create(dto, actor);
  }

  @Patch(':id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SupplierPatchDto) {
    return this.suppliers.update(id, dto);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.remove(id);
  }
}
