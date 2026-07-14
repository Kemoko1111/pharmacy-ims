import { DosageForm } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class UnitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  unitName: string;

  @IsInt()
  @Min(1)
  factorToBase: number;

  @IsNumberString()
  sellingPrice: string;
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  genericName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  strength?: string;

  @IsEnum(DosageForm)
  form: DosageForm;

  @IsUUID()
  categoryId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  baseUnit: string;

  @IsNumberString()
  sellingPriceBase: string;

  @IsInt()
  @Min(0)
  reorderLevel: number;

  @IsBoolean()
  vatApplies: boolean;

  @IsBoolean()
  prescriptionOnly: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  legacyItemNo?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UnitDto)
  units?: UnitDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  barcodes?: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  genericName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  strength?: string;

  @IsOptional()
  @IsEnum(DosageForm)
  form?: DosageForm;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsNumberString()
  sellingPriceBase?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  reorderLevel?: number;

  @IsOptional()
  @IsBoolean()
  vatApplies?: boolean;

  @IsOptional()
  @IsBoolean()
  prescriptionOnly?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class AddUnitDto extends UnitDto {}

export class AddBarcodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  barcode: string;

  @IsOptional()
  @IsUUID()
  productUnitId?: string;
}

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name: string;
}

export class ProductsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 25;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  lowStock?: string; // 'true'

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  ids?: string[];
}
