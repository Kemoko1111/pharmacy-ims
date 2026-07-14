import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { CategoriesController } from './categories.controller';
import { BarcodesController } from './barcodes.controller';
import { CatalogService } from './catalog.service';
import { ImportService } from './import.service';

@Module({
  controllers: [ProductsController, CategoriesController, BarcodesController],
  providers: [CatalogService, ImportService],
  exports: [CatalogService],
})
export class CatalogModule {}
