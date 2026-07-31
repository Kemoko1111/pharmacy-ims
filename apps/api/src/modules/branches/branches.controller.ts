import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { CreateBranchDto, UpdateBranchDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /**
   * Readable by any signed-in user: the transfer destination picker and the
   * branch switcher both need the list. Seeing that a shop exists is not the
   * same as being able to read its stock (ADR-010).
   */
  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.branches.list(includeInactive === 'true');
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateBranchDto, @CurrentUser() user: RequestUser) {
    return this.branches.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.branches.update(id, dto, user.id);
  }
}
