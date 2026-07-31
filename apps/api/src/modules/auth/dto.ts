import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceLabel?: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class SwitchBranchDto {
  /** null ⇒ consolidated all-branch mode (ADMIN, read-only). */
  @IsOptional()
  @IsUUID()
  branchId?: string | null;
}
