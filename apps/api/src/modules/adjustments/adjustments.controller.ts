import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AdjustmentReason } from '@prisma/client';
import { IsEnum, IsInt, IsNotIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AdjustmentsService } from './adjustments.service';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { PageQuery } from '../../common/pagination';

class CreateAdjustmentDto {
  @IsUUID()
  productId: string;

  @IsUUID()
  batchId: string;

  @IsInt()
  @IsNotIn([0])
  qtyDelta: number;

  @IsEnum(AdjustmentReason)
  reason: AdjustmentReason;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

class DecideDto {
  @IsEnum({ APPROVED: 'APPROVED', REJECTED: 'REJECTED' })
  decision: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

class AdjustmentsQuery extends PageQuery {
  @IsOptional()
  @IsString()
  status?: string;
}

@Controller('adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Post()
  @Roles('INVENTORY_OFFICER', 'PHARMACIST', 'MANAGER')
  create(@Body() dto: CreateAdjustmentDto, @CurrentUser() actor: RequestUser) {
    return this.adjustments.create(dto, actor);
  }

  @Post('quarantine-expired')
  @Roles('PHARMACIST', 'MANAGER')
  quarantineExpired(@CurrentUser() actor: RequestUser) {
    return this.adjustments.quarantineExpired(actor);
  }

  @Post(':id/approve')
  @Roles('MANAGER')
  decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.adjustments.decide(id, dto.decision, dto.note, actor);
  }

  @Get()
  @Roles('MANAGER', 'PHARMACIST', 'INVENTORY_OFFICER')
  list(@Query() q: AdjustmentsQuery) {
    return this.adjustments.list({ page: q.page ?? 1, pageSize: q.pageSize ?? 25, status: q.status });
  }

  @Get(':id')
  @Roles('MANAGER', 'PHARMACIST', 'INVENTORY_OFFICER')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.adjustments.get(id);
  }
}
