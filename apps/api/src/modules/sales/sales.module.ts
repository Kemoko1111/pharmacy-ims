import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { ReturnsService } from './returns.service';

@Module({
  controllers: [SalesController],
  providers: [SalesService, ReturnsService],
})
export class SalesModule {}
