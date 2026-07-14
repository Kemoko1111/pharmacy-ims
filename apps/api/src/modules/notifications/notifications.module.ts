import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { JobsService } from './jobs.service';
import { SmsService } from './sms.service';

@Module({
  controllers: [NotificationsController],
  providers: [JobsService, SmsService],
  exports: [SmsService],
})
export class NotificationsModule {}
