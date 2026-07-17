import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { PageQuery } from '../../common/pagination';

export class BatchesQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expiringWithinDays?: number;

  @IsOptional()
  @IsString()
  status?: string;
}

export class MovementsQuery extends PageQuery {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  type?: string;
}
