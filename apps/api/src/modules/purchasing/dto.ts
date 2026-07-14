import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const numeric = () => Transform(({ value }) => (value === undefined || value === null ? value : String(value)));

export class PoItemDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  qtyBase: number;

  @numeric()
  @IsNumberString()
  unitCost: string;
}

export class CreatePoDto {
  @IsUUID()
  supplierId: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items: PoItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class FromSuggestionsDto {
  @IsUUID()
  supplierId: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  productIds?: string[];
}

export class ReceiptItemDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  qtyBase: number;

  @numeric()
  @IsNumberString()
  unitCost: string;

  @IsString()
  @MaxLength(60)
  batchNumber: string;

  @IsDateString()
  expiryDate: string;
}

export class CreateReceiptDto {
  @IsOptional()
  @IsUUID()
  poId?: string;

  @IsUUID()
  supplierId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReceiptItemDto)
  items: ReceiptItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Manager sign-off for receiving more than the PO ordered (US-09 AC2). */
  @IsOptional()
  @IsBoolean()
  allowOverReceipt?: boolean;
}
