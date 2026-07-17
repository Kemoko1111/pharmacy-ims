import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * US-15: customer records are health-adjacent (purchase history reveals
 * conditions), so access is Pharmacist/Manager only per the Act 843 note in
 * the requirements doc. `notes` is the clinically sensitive field.
 */
export class CustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CustomerPatchDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
