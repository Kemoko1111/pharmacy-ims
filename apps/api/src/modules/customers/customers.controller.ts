import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { PageQuery } from '../../common/pagination';
import { CustomersService } from './customers.service';
import { CustomerDto, CustomerPatchDto } from './dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles('PHARMACIST', 'MANAGER')
  list(@Query() q: PageQuery) {
    return this.customers.list(q);
  }

  @Post()
  @Roles('PHARMACIST', 'MANAGER')
  create(@Body() dto: CustomerDto) {
    return this.customers.create(dto);
  }

  @Patch(':id')
  @Roles('PHARMACIST', 'MANAGER')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerPatchDto) {
    return this.customers.update(id, dto);
  }

  @Get(':id/history')
  @Roles('PHARMACIST', 'MANAGER')
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: PageQuery) {
    return this.customers.history(id, q);
  }
}
