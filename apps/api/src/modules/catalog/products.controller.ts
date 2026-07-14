import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { AddBarcodeDto, AddUnitDto, CreateProductDto, ProductsQuery, UpdateProductDto } from './dto';
import { Roles } from '../../common/roles.decorator';
import { CurrentUser } from '../../common/current-user.decorator';
import type { RequestUser } from '../../common/jwt-auth.guard';

@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@Query() q: ProductsQuery) {
    return this.catalog.listProducts(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getProduct(id);
  }

  @Post()
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  create(@Body() dto: CreateProductDto, @CurrentUser() actor: RequestUser) {
    return this.catalog.createProduct(dto, actor);
  }

  @Patch(':id')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.updateProduct(id, dto, actor);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: RequestUser) {
    await this.catalog.softDeleteProduct(id, actor);
  }

  @Post(':id/units')
  @Roles('MANAGER')
  addUnit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddUnitDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.addUnit(id, dto, actor);
  }

  @Post(':id/barcodes')
  @Roles('INVENTORY_OFFICER', 'MANAGER')
  addBarcode(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddBarcodeDto,
    @CurrentUser() actor: RequestUser,
  ) {
    return this.catalog.addBarcode(id, dto, actor);
  }
}
