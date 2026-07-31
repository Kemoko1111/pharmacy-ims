import { UserRole } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
const PASSWORD_MSG = 'Password needs 8+ chars with upper, lower and a digit';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z0-9._-]+$/i, { message: 'Username: letters, digits, . _ - only' })
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  password: string;

  /**
   * Branches this user may work in (ADR-010). Required: an account with no
   * branch cannot sign in at all, so silently creating one is a trap.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  branchIds: string[];

  /** Which of `branchIds` to open at login. Defaults to the first. */
  @IsOptional()
  @IsUUID()
  defaultBranchId?: string;
}

export class UpdateUserDto {
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
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Replaces the user's branch assignments wholesale when present. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  branchIds?: string[];

  @IsOptional()
  @IsUUID()
  defaultBranchId?: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  newPassword: string;
}
