import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { CategoriesController } from './categories.controller';
import { BarcodesController } from './barcodes.controller';
import { CatalogService } from './catalog.service';

@Module({
  controllers: [ProductsController, CategoriesController, BarcodesController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
