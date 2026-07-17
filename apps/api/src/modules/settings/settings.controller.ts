import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Roles('ADMIN', 'MANAGER')
  get() {
    return this.settings.get();
  }

  @Patch()
  @Roles('ADMIN')
  patch(@Body() body: Record<string, unknown>, @CurrentUser() actor: RequestUser) {
    return this.settings.patch(body, actor);
  }
}
