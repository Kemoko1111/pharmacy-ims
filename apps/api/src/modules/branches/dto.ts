import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateBranchDto {
  /** Prefixes every receipt, PO and GRN number, so short and stable. */
  @IsString()
  @Matches(/^[A-Za-z]{2,6}$/, { message: 'Code must be 2–6 letters' })
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /** Overrides the global receipt_header setting for this shop. */
  @IsOptional()
  @IsObject()
  receiptHeader?: Record<string, string>;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  receiptHeader?: Record<string, string>;
}
