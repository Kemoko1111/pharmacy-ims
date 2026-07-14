import { PaymentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsISO8601,
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

export class SaleItemDto {
  @IsUUID()
  productId: string;

  @IsOptional()
  @IsUUID()
  productUnitId?: string | null;

  @IsInt()
  @Min(1)
  quantity: number;

  @numeric()
  @IsNumberString()
  unitPrice: string;

  @IsOptional()
  @numeric()
  @IsNumberString()
  discount?: string;
}

export class PaymentDto {
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @numeric()
  @IsNumberString()
  amount: string;

  @IsOptional()
  @numeric()
  @IsNumberString()
  tendered?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  momoRef?: string;
}

export class SaleCreateDto {
  @IsUUID()
  clientSaleId: string;

  @IsISO8601()
  soldAt: string;

  @IsOptional()
  @IsUUID()
  customerId?: string | null;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PaymentDto)
  payments: PaymentDto[];
}

export class SyncSalesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleCreateDto)
  sales: SaleCreateDto[];
}

export class VoidSaleDto {
  @IsString()
  @MaxLength(300)
  reason: string;
}
