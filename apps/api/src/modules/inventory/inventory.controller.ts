import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { InventoryService } from './inventory.service';
import { BatchesQuery, MovementsQuery } from './dto';

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('batches')
  listBatches(@Query() q: BatchesQuery) {
    return this.inventory.listBatches(q);
  }

  // Reads a view, so branch comes from the token rather than the extension.
  @Get('inventory/stock')
  stock(@CurrentUser() user: RequestUser, @Query('lowStock') lowStock?: string) {
    return this.inventory.stock(user.branchId, lowStock);
  }

  @Get('inventory/movements')
  @Roles('MANAGER')
  movements(@Query() q: MovementsQuery) {
    return this.inventory.movements(q);
  }
}
