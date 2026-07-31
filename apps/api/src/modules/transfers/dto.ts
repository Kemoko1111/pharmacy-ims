import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class TransferItemDto {
  /** A batch on the sending branch's shelf — picked explicitly, as adjustments do. */
  @IsUUID()
  sourceBatchId: string;

  @IsInt()
  @Min(1)
  qtyBase: number;
}

export class CreateTransferDto {
  @IsUUID()
  toBranchId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items: TransferItemDto[];
}

export class ReceiveTransferItemDto {
  @IsUUID()
  itemId: string;

  /** Short receipts are normal — goods go missing in transit. */
  @IsInt()
  @Min(0)
  qtyReceived: number;
}

export class ReceiveTransferDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveTransferItemDto)
  items?: ReceiveTransferItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
