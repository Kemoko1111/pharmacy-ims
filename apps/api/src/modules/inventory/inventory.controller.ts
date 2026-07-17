import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { InventoryService } from './inventory.service';
import { BatchesQuery, MovementsQuery } from './dto';

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('batches')
  listBatches(@Query() q: BatchesQuery) {
    return this.inventory.listBatches(q);
  }

  @Get('inventory/stock')
  stock(@Query('lowStock') lowStock?: string) {
    return this.inventory.stock(lowStock);
  }

  @Get('inventory/movements')
  @Roles('MANAGER')
  movements(@Query() q: MovementsQuery) {
    return this.inventory.movements(q);
  }
}
