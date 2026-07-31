import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, SwitchBranchDto } from './dto';
import { Public } from '../../common/public.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ global: { ttl: 60_000, limit: 5 } }) // US-01 AC2: 5/min/IP
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.auth.login(dto.username, dto.password, dto.deviceLabel, ip);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.auth.me(user.id, user.branchId);
  }

  /**
   * Re-issues the access token against another branch (ADR-010). Branch lives
   * in the signed token, so switching is a round-trip rather than a header the
   * client could assert for itself.
   */
  @Post('switch-branch')
  @HttpCode(200)
  switchBranch(@CurrentUser() user: RequestUser, @Body() dto: SwitchBranchDto) {
    return this.auth.switchBranch(user.id, dto.branchId ?? null);
  }
}
